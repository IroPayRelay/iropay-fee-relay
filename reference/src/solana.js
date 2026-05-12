// src/solana.js
// Manual Solana wire-format helpers — base58, compact-u16, transaction parsing.
// Adapted from crypto-pay/functions/api/relay.js so we don't pull in the heavy
// @solana/web3.js bundle (Workers have a 1 MiB compressed bundle limit).
//
// We parse just enough to:
//   - Identify the fee-payer slot (account_keys[0])
//   - Walk every instruction (program id + account indexes + data)
//   - Re-emit the wire bytes after inserting our signature into slot 0
//
// Constants
export const TOKEN_PROGRAM_ID_B58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const MEMO_PROGRAM_ID_B58 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ---------------------------------------------------------------------------
// Base58 (Bitcoin alphabet, used by Solana)
// ---------------------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('base58Decode: empty input');
  }
  let num = 0n;
  for (const c of str) {
    const idx = B58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  // Convert bigint → bytes (big-endian)
  const hex = num.toString(16);
  const padded = hex.length % 2 ? '0' + hex : hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  }
  // Re-add leading zero bytes (one per leading '1' in base58)
  let leadingZeros = 0;
  for (const c of str) {
    if (c === '1') leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    const result = new Uint8Array(leadingZeros + bytes.length);
    result.set(bytes, leadingZeros);
    return result;
  }
  return bytes;
}

export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('base58Encode: expected Uint8Array');
  }
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = '';
  while (num > 0n) {
    result = B58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  // Re-add a '1' for each leading zero byte
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result = '1' + result;
  return result;
}

// ---------------------------------------------------------------------------
// Compact-u16 (Solana shortvec)
// ---------------------------------------------------------------------------

export function readCompactU16(bytes, offset) {
  let val = bytes[offset];
  if (val <= 0x7f) return [val, offset + 1];
  val = (val & 0x7f) | (bytes[offset + 1] << 7);
  if (bytes[offset + 1] <= 0x7f) return [val, offset + 2];
  val = (val & 0x3fff) | (bytes[offset + 2] << 14);
  return [val, offset + 3];
}

// ---------------------------------------------------------------------------
// Little-endian u64 (used by SPL Token Transfer instruction amounts)
// ---------------------------------------------------------------------------

export function readU64LE(bytes, offset) {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('hexToBytes: invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Byte equality
// ---------------------------------------------------------------------------

export function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transaction parsing (legacy v0 message format — same as functions/api/relay.js)
// ---------------------------------------------------------------------------

/**
 * Parse a serialized Solana transaction (legacy format).
 * Returns the signatures, account keys, instructions, and the offsets needed
 * to splice the fee-payer signature into slot 0 later.
 */
export function parseTransaction(txBytes) {
  let offset = 0;

  // 1. Number of signatures
  const [numSigs, sigEnd] = readCompactU16(txBytes, offset);
  offset = sigEnd;

  // 2. Signatures (64 bytes each)
  const signaturesStart = offset;
  const signatures = [];
  for (let i = 0; i < numSigs; i++) {
    signatures.push(txBytes.slice(offset, offset + 64));
    offset += 64;
  }

  // 3. Message starts here
  const messageStart = offset;
  const messageBytes = txBytes.slice(messageStart);

  // 4. Message header (3 bytes)
  const numRequiredSigs = txBytes[offset++];
  const numReadonlySigned = txBytes[offset++];
  const numReadonlyUnsigned = txBytes[offset++];

  // 5. Account keys
  const [numAccounts, accEnd] = readCompactU16(txBytes, offset);
  offset = accEnd;
  const accountKeys = [];
  for (let i = 0; i < numAccounts; i++) {
    accountKeys.push(txBytes.slice(offset, offset + 32));
    offset += 32;
  }

  // 6. Recent blockhash (32 bytes)
  const recentBlockhash = txBytes.slice(offset, offset + 32);
  offset += 32;

  // 7. Instructions
  const [numInstructions, instrEnd] = readCompactU16(txBytes, offset);
  offset = instrEnd;
  const instructions = [];
  for (let i = 0; i < numInstructions; i++) {
    const programIdIndex = txBytes[offset++];
    const [numAccIdx, accIdxEnd] = readCompactU16(txBytes, offset);
    offset = accIdxEnd;
    const accountIndexes = [];
    for (let j = 0; j < numAccIdx; j++) {
      accountIndexes.push(txBytes[offset++]);
    }
    const [dataLen, dataEnd] = readCompactU16(txBytes, offset);
    offset = dataEnd;
    const data = txBytes.slice(offset, offset + dataLen);
    offset += dataLen;
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  return {
    numSigs,
    signaturesStart,
    signatures,
    messageStart,
    messageBytes,
    numRequiredSigs,
    numReadonlySigned,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

/**
 * Find the account-keys index of a given base58 program/account id.
 * Returns -1 if not present in the tx.
 */
export function findAccountIndex(parsed, b58Pubkey) {
  const target = base58Decode(b58Pubkey);
  for (let i = 0; i < parsed.accountKeys.length; i++) {
    if (arraysEqual(parsed.accountKeys[i], target)) return i;
  }
  return -1;
}

/**
 * Insert the fee-payer signature into signature slot 0, return the resulting
 * base64 string ready to send to Solana RPC.
 */
export function spliceFeePayerSignature(txBytes, signaturesStart, signature) {
  if (signature.length !== 64) {
    throw new Error('spliceFeePayerSignature: signature must be 64 bytes');
  }
  const out = new Uint8Array(txBytes.length);
  out.set(txBytes);
  out.set(signature, signaturesStart); // slot 0
  // Worker-friendly base64 encode
  let bin = '';
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
  return btoa(bin);
}
