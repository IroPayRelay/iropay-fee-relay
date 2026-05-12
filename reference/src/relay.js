// src/relay.js
// POST /relay — co-signs and submits a partially-signed Solana transaction.
//
// Two flow types (selected by request body's `type` field):
//
//   "payment"  → SPL Memo (kind:"pay") + USDC transfer to recipient +
//                USDC transfer to relay fee-payer ATA.
//                Fee math per `cfg.fees.payment`:
//                  - percent : max(amount * rate, min), rounded UP to 0.01
//                  - flat    : `cfg.fees.payment.amount` EXACTLY (no min, no round-up)
//
//   "memo"     → SPL Memo (kind:"backup" or kind:"ack") + optional USDC
//                transfer to relay fee-payer ATA (omitted when cfg.fees.memo === 0,
//                which is the default for most relays).
//                kind:"backup" also includes a second SPL Memo with the
//                binary-encoded encrypted seed payload (signed by the passkey
//                wallet so the tx is findable via getSignaturesForAddress).
//
// Returns { signature } on success, { error } on failure.
// CORS open (PWA clients run cross-origin in the browser).

import nacl from 'tweetnacl';
import {
  TOKEN_PROGRAM_ID_B58,
  MEMO_PROGRAM_ID_B58,
  base58Decode,
  base58Encode,
  parseTransaction,
  findAccountIndex,
  spliceFeePayerSignature,
  arraysEqual,
  readU64LE,
  hexToBytes,
} from './solana.js';
import {
  decodeMemoData,
  parseIroPayMemo,
  isPaymentMemo,
  isBackupMemo,
  isAckMemo,
} from './memo.js';
import { configFromRequest } from './config.js';
// NOTE — this reference impl ships WITHOUT anti-spam protection. The
// production IroPay relay-worker adds: Cloudflare Turnstile (invisible
// captcha for free memo flows), per-IP daily quotas, and a per-wallet
// reputation system that gives "credits" to wallets that have paid
// fees before. None of that is part of the spec — operators are free
// to add their own protection wherever they want. A suggested hook
// point is just below the "Verify fee payer slot 0" check (search for
// "ANTI-SPAM HOOK").

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

// SPL Token Transfer instruction discriminator (legacy SPL Token program)
const TOKEN_TRANSFER_DISCRIMINATOR = 3;
// USDC has 6 decimals — 1 USDC = 1_000_000 raw.
const USDC_RAW_PER_UNIT = 1_000_000n;
// 1 cent in raw USDC: 0.01 * 1e6 = 10_000.
const ONE_CENT_RAW = 10_000n;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function relayHandler(request, env, ctx) {
  // Resolve mode config from hostname (default | test). Unknown hosts → default.
  const cfg = configFromRequest(request);

  // 1. Parse and validate the request body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const { tx: txBase64, type } = body || {};
  if (typeof txBase64 !== 'string' || txBase64.length === 0) {
    return jsonError('tx (base64) required', 400);
  }
  // type:"cancellation" is a deprecated type — request memos are now an
  // off-chain concern (the client coordinates request state without
  // touching the relay). Return 410 with a stable error code so older
  // clients that still try this path get a structured response.
  if (type === 'cancellation') {
    return jsonError('cancellation_type_deprecated', 410);
  }
  if (type !== 'memo' && type !== 'payment') {
    return jsonError(`Invalid type "${type}"`, 400);
  }

  // 2. Validate environment is wired correctly (early failure → clearer errors)
  if (!env.FEE_PAYER_SECRET) return jsonError('Relay misconfigured (missing secret)', 500);
  if (!env.FEE_PAYER_PUBKEY) return jsonError('Relay misconfigured (missing pubkey)', 500);
  if (!env.FEE_PAYER_USDC_ATA) return jsonError('Relay misconfigured (missing USDC ATA)', 500);
  if (!env.HELIUS_RPC) return jsonError('Relay misconfigured (missing RPC)', 500);

  // 3. Decode tx bytes
  let txBytes;
  try {
    txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
  } catch {
    return jsonError('Invalid base64 transaction', 400);
  }

  let parsed;
  try {
    parsed = parseTransaction(txBytes);
  } catch (e) {
    return jsonError('Failed to parse transaction: ' + e.message, 400);
  }

  // 4. Verify fee payer slot 0 matches our pubkey
  let feePayerBytes;
  try {
    feePayerBytes = base58Decode(env.FEE_PAYER_PUBKEY);
  } catch (e) {
    return jsonError('Relay misconfigured (bad pubkey): ' + e.message, 500);
  }
  if (!parsed.accountKeys[0] || !arraysEqual(parsed.accountKeys[0], feePayerBytes)) {
    return jsonError('Fee payer mismatch', 400);
  }

  // 4b. ANTI-SPAM HOOK — insert your protection here if needed.
  //
  // Free flows (kind:"backup" + kind:"ack" memos) cost the spammer nothing
  // and are the most likely abuse vector. Paid flows (type:"payment")
  // self-rate-limit via the USDC fee and are typically left unprotected.
  //
  // Production IroPay relay uses (this reference impl does NOT include):
  //   - Cloudflare Turnstile (invisible captcha for free flows)
  //   - Per-IP daily quota (50/day for free flows)
  //   - Per-wallet reputation system (bypass for paying wallets)
  //
  // Suggested pattern:
  //
  //   if (type !== 'payment') {
  //     if (!await myAntiSpamCheck(request, env)) {
  //       return jsonError('Rate limited', 429);
  //     }
  //   }

  // 5. Validate the instructions match the declared `type`
  let validation;
  try {
    if (type === 'payment') {
      validation = validatePaymentTx(parsed, env, cfg);
    } else {
      // type === 'memo' — currently kind:"backup" (passkey-link) and
      // kind:"ack" (merchant-side payment attestation). Other memo kinds
      // return 410 + memo_type_deprecated.
      validation = validateMemoTx(parsed, env, cfg);
    }
  } catch (e) {
    return jsonError('Validation error: ' + e.message, 500);
  }

  if (!validation.valid) {
    return jsonError(validation.reason, validation.status || 400);
  }

  // 6. Sign the message bytes
  let secretBytes;
  try {
    secretBytes = hexToBytes(env.FEE_PAYER_SECRET);
  } catch {
    return jsonError('Relay misconfigured (bad secret)', 500);
  }
  const signature = nacl.sign.detached(parsed.messageBytes, secretBytes);
  const signedTxB64 = spliceFeePayerSignature(txBytes, parsed.signaturesStart, signature);

  // 7. Submit to Solana RPC
  let txSignature;
  try {
    txSignature = await submitToSolana(env.HELIUS_RPC, signedTxB64);
  } catch (e) {
    return jsonError('Solana submission failed: ' + e.message, 502);
  }

  // POST-SUBMIT HOOK — insert accounting / logging here if needed.
  //
  // Suggested patterns:
  //   - Reputation: ctx.waitUntil(creditFee(env, payer, fee, 'direct'))
  //   - Logging:    ctx.waitUntil(logTx(env, txSignature, type, fee))
  //   - Monitoring: ctx.waitUntil(reportToPrometheus(...))
  //
  // ctx.waitUntil() lets the work finish AFTER the HTTP response returns,
  // so it doesn't add latency to the client.
  return jsonOk({ signature: txSignature });
}

// ---------------------------------------------------------------------------
// Memo (kind:"backup" + kind:"ack") validation
// ---------------------------------------------------------------------------

/**
 * Validate a memo-type tx — accepts kind:"backup" (passkey-link encrypted
 * seed backup) and kind:"ack" (merchant-side payment attestation).
 * All other memo kinds — including kind:"pay" which has its own
 * type:"payment" POST path — return 410 + memo_type_deprecated.
 *
 * Expected instruction layout — kind:"backup":
 *   - exactly one IroPay JSON memo with kind:"backup"
 *   - optional SPL Token Transfer to the relay fee-payer ATA at cfg.fees.memo
 *     (omitted entirely when cfg.fees.memo === 0)
 *   - the tx may carry an additional non-IroPay memo instruction (the binary
 *     blob, base64-encoded) signed by the passkey wallet — we don't validate
 *     or care about that one. It's how the recovery scan finds the backup
 *     later via getSignaturesForAddress(passkeyPubkey).
 *
 * Expected instruction layout — kind:"ack":
 *   - exactly one IroPay JSON memo with kind:"ack"
 *   - optional SPL Token Transfer to the relay fee-payer ATA at cfg.fees.memo
 *     (omitted entirely when cfg.fees.memo === 0)
 *
 * Free-memo path (cfg.fees.memo === 0):
 *   - kind:"backup" + kind:"ack" memos bypass the fee instruction entirely.
 *   - Returns { valid, isFreeMemo: true, isBackup, isAck }.
 *   - Recommended default — the spec's revenue model is the payment fee.
 *
 * Deprecated paths (status:410, reason:'memo_type_deprecated'):
 *   - kind:"pay" (use type:"payment" POST instead)
 *   - any unknown kind
 *
 * Pure (sync) — no I/O. The function inspects the parsed tx and returns
 * a verdict; the caller decides what to do with the response.
 */
export function validateMemoTx(parsed, env, cfg) {
  const memoIdx = findAccountIndex(parsed, MEMO_PROGRAM_ID_B58);
  if (memoIdx === -1) {
    return { valid: false, reason: 'Missing SPL Memo program' };
  }

  // Pull every memo-program instruction; require exactly one IroPay memo.
  // Non-IroPay memos (e.g. the passkey-backup binary-blob memo) are ignored
  // here — parseIroPayMemo returns null on those.
  let memo = null;
  for (const ix of parsed.instructions) {
    if (ix.programIdIndex !== memoIdx) continue;
    const text = decodeMemoData(ix.data);
    const candidate = parseIroPayMemo(text);
    if (candidate) {
      if (memo) return { valid: false, reason: 'Multiple IroPay memos' };
      memo = candidate;
    }
  }
  if (!memo) return { valid: false, reason: 'No valid IroPay memo' };

  // Accept kind:"backup" and kind:"ack". Anything else gets the deprecated
  // 410 sentinel — distinct from a generic 400 so the client can surface a
  // structured error code (stable across spec versions).
  const isBackup = isBackupMemo(memo);
  const isAck = isAckMemo(memo);
  if (!isBackup && !isAck) {
    return { valid: false, status: 410, reason: 'memo_type_deprecated' };
  }

  // Free-memo bypass: when the mode config sets memo fee to 0, kind:"backup"
  // + kind:"ack" are accepted with NO fee transfer.
  if (cfg.fees.memo === 0) {
    return { valid: true, isFreeMemo: true, isBackup, isAck };
  }

  // Look for a USDC transfer to our fee-payer USDC ATA.
  // accountIndexes[1] of an SPL Token Transfer is the destination TOKEN ACCOUNT (ATA),
  // not the owner wallet. We compare against the pre-derived ATA from env.
  const feeAtaBytes = base58Decode(env.FEE_PAYER_USDC_ATA);
  const feeRaw = floatToRaw(cfg.fees.memo);
  const transferToUs = findUsdcTransferToPayee(parsed, feeAtaBytes);

  if (!transferToUs) {
    return { valid: false, reason: 'Missing fee transfer to relay wallet' };
  }
  if (transferToUs.amount < feeRaw) {
    return {
      valid: false,
      reason: `Insufficient memo fee: got ${transferToUs.amount}, need ${feeRaw}`,
    };
  }

  return { valid: true, isBackup, isAck };
}

// ---------------------------------------------------------------------------
// Payment validation
// ---------------------------------------------------------------------------

/**
 * Validate a payment-type tx.
 * Expected instruction layout (any order, but exactly):
 *   - 1 SPL Memo Program instruction whose data parses as a valid IroPay
 *     payment memo (kind: "pay").
 *   - 2 SPL Token Transfer instructions:
 *       (a) recipient transfer — destination is NOT our fee-payer wallet,
 *           amount is `paymentAmount`.
 *       (b) fee transfer — destination IS our fee-payer wallet, amount is
 *           `>= computePaymentFeeRaw(paymentAmount, cfg)`.
 */
export function validatePaymentTx(parsed, env, cfg) {
  const memoIdx = findAccountIndex(parsed, MEMO_PROGRAM_ID_B58);
  const tokenIdx = findAccountIndex(parsed, TOKEN_PROGRAM_ID_B58);
  if (memoIdx === -1) return { valid: false, reason: 'Missing SPL Memo program' };
  if (tokenIdx === -1) return { valid: false, reason: 'Missing SPL Token program' };

  // Find exactly one IroPay payment memo
  let memo = null;
  for (const ix of parsed.instructions) {
    if (ix.programIdIndex !== memoIdx) continue;
    const text = decodeMemoData(ix.data);
    const candidate = parseIroPayMemo(text);
    if (candidate) {
      if (memo) return { valid: false, reason: 'Multiple IroPay memos' };
      memo = candidate;
    }
  }
  if (!memo) return { valid: false, reason: 'No valid IroPay memo' };
  if (!isPaymentMemo(memo)) {
    return { valid: false, reason: `Memo kind must be "pay" (got "${memo.kind}")` };
  }

  // Walk every SPL Token Transfer, classify by destination ATA.
  const feeAtaBytes = base58Decode(env.FEE_PAYER_USDC_ATA);
  const transfers = collectUsdcTransfers(parsed);

  if (transfers.length < 2) {
    return { valid: false, reason: `Expected 2 USDC transfers, got ${transfers.length}` };
  }

  let feeTransfer = null;
  let recipientTransfer = null;
  for (const t of transfers) {
    if (arraysEqual(t.destination, feeAtaBytes)) {
      if (feeTransfer) return { valid: false, reason: 'Duplicate fee transfer' };
      feeTransfer = t;
    } else {
      // Pick the largest non-fee transfer as the recipient transfer.
      if (!recipientTransfer || t.amount > recipientTransfer.amount) {
        recipientTransfer = t;
      }
    }
  }
  if (!feeTransfer) return { valid: false, reason: 'Missing fee transfer to relay wallet' };
  if (!recipientTransfer) return { valid: false, reason: 'Missing recipient transfer' };

  const requiredFeeRaw = computePaymentFeeRaw(recipientTransfer.amount, cfg);
  if (feeTransfer.amount < requiredFeeRaw) {
    return {
      valid: false,
      reason: `Insufficient payment fee: got ${feeTransfer.amount}, need ${requiredFeeRaw}`,
    };
  }

  // Extract bookkeeping fields the post-submit hook in relayHandler may want
  // to act on. The payer signs the SPL Token transfer, and accountKeys[1] is
  // their pubkey (slot 0 = fee payer = relay).
  const payerPubkey = parsed.accountKeys[1] ? base58Encode(parsed.accountKeys[1]) : null;
  const paymentFeeUsdc = Number(requiredFeeRaw) / 1_000_000;

  return { valid: true, payerPubkey, paymentFeeUsdc };
}

// ---------------------------------------------------------------------------
// Token transfer extraction
// ---------------------------------------------------------------------------

/**
 * Walk the parsed tx and return every SPL Token Transfer instruction (legacy
 * variant — discriminator 3) as { destination: Uint8Array, amount: bigint }.
 *
 * The legacy Transfer instruction account layout is:
 *   [source, destination, authority, ...optional multisig signers]
 * So accountIndexes[1] is the destination ATA owner address bytes.
 *
 * Note: for SPL Token transfers, accountIndexes[1] points at the destination
 * TOKEN ACCOUNT (ATA), not the destination wallet. Callers must compare against
 * the ATA of (FEE_PAYER_PUBKEY, USDC_MINT), which we pre-derive once and store
 * as env.FEE_PAYER_USDC_ATA — see wrangler.toml. This avoids bundling
 * @solana/spl-token (curve25519 + SHA256 + find_program_address) inside the
 * Worker.
 */
export function collectUsdcTransfers(parsed) {
  const tokenIdx = findAccountIndex(parsed, TOKEN_PROGRAM_ID_B58);
  if (tokenIdx === -1) return [];
  const out = [];
  for (const ix of parsed.instructions) {
    if (ix.programIdIndex !== tokenIdx) continue;
    if (ix.data.length < 9) continue;
    if (ix.data[0] !== TOKEN_TRANSFER_DISCRIMINATOR) continue;
    const amount = readU64LE(ix.data, 1);
    const destAccountIndex = ix.accountIndexes[1];
    if (destAccountIndex == null) continue;
    const destination = parsed.accountKeys[destAccountIndex];
    if (!destination) continue;
    out.push({ destination, amount });
  }
  return out;
}

/**
 * Find the (single) USDC transfer whose destination matches `payeeBytes`.
 * Returns the {destination, amount} entry or null.
 */
function findUsdcTransferToPayee(parsed, payeeBytes) {
  const transfers = collectUsdcTransfers(parsed);
  for (const t of transfers) {
    if (arraysEqual(t.destination, payeeBytes)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fee math (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert a USDC float (e.g. 0.01) to raw USDC units (bigint).
 * Always rounded UP to the nearest 1 raw unit (defensive against float drift).
 */
export function floatToRaw(n) {
  if (typeof n !== 'number') throw new TypeError('floatToRaw: expected number');
  if (!Number.isFinite(n) || n < 0) throw new Error(`floatToRaw: invalid amount "${n}"`);
  // Round to 6-decimal precision (USDC's smallest unit), then up to int.
  return BigInt(Math.ceil(n * Number(USDC_RAW_PER_UNIT)));
}

/**
 * Compute the required fee in raw USDC for a payment of `amountRaw` raw USDC,
 * given the mode config.
 *
 * Percent fees are rounded UP to the nearest cent (0.01 USDC), matching the
 * client's display precision. Flat fees are NOT rounded — a 0.001 USDC flat
 * fee stays at exactly 1000 raw units. (Earlier versions rounded everything
 * up; that defeated the point of advertising a sub-cent flat fee.)
 */
export function computePaymentFeeRaw(amountRaw, cfg) {
  const p = cfg.fees.payment;
  if (p.type === 'percent') {
    const minRaw = floatToRaw(p.min);
    // amountRaw * rate, computed via integer-ish math:
    //   percentRaw = amountRaw * (rate * 1e9) / 1e9   (use 1e9 scale = 9 dp of precision)
    const SCALE = 1_000_000_000n;
    const rateScaled = BigInt(Math.round(p.rate * Number(SCALE)));
    const candidate = (amountRaw * rateScaled) / SCALE;
    const feeRaw = candidate > minRaw ? candidate : minRaw;
    return roundUpCentRaw(feeRaw);
  }
  if (p.type === 'flat') {
    // Flat fees are exact — no min, no round-up. A 0.001 USDC flat fee should
    // stay 0.001 USDC, not balloon to 0.01.
    return floatToRaw(p.amount);
  }
  throw new Error(`Unsupported payment fee type: ${p.type}`);
}

/**
 * Round a raw USDC bigint UP to the nearest cent (10_000 raw units).
 */
export function roundUpCentRaw(raw) {
  const remainder = raw % ONE_CENT_RAW;
  if (remainder === 0n) return raw;
  return raw + (ONE_CENT_RAW - remainder);
}

// ---------------------------------------------------------------------------
// Solana RPC submission
// ---------------------------------------------------------------------------

async function submitToSolana(rpcUrl, signedTxBase64) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [signedTxBase64, {
        encoding: 'base64',
        // skipPreflight saves ~1-2s of simulation latency. Industry
        // standard for SPL token transfers — Phantom, Solflare, Jupiter
        // all do this by default. We've already validated the tx
        // structure (parseTransferInstruction, fee math, memo presence),
        // so preflight is redundant.
        skipPreflight: true,
        maxRetries: 0,
      }],
    }),
  });
  const result = await res.json();

  if (result.error) {
    throw new Error(result.error.message || 'RPC error');
  }
  if (typeof result.result !== 'string') {
    throw new Error('RPC returned no signature');
  }
  return result.result;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonOk(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: CORS_HEADERS });
}

function jsonError(reason, status) {
  return new Response(JSON.stringify({ error: reason }), { status, headers: CORS_HEADERS });
}
