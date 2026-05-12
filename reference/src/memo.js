// src/memo.js
// Memo schema validation — accepts v1, v2, and v3 (encrypted) shapes per
// the spec doc (docs/spec.md §4).
//
// Schema v3 introduces end-to-end encryption for kind:"pay" and kind:"ack"
// memos. The relay never decrypts — it only validates the public envelope
// and the presence + base64 sanity of the `enc` block. Backup memos stay
// at v=2 (no encryption layer added — their payload is already encrypted
// at the application level via the passkey-derived key).

export const MEMO_VERSION = 3;
const APP_NAME = 'iropay';

/**
 * Decode a memo instruction's data bytes (UTF-8) into a string.
 */
export function decodeMemoData(dataBytes) {
  if (!(dataBytes instanceof Uint8Array)) {
    throw new TypeError('decodeMemoData: expected Uint8Array');
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(dataBytes);
}

/**
 * Parse + return the IroPay memo. Accepts v1, v2 (non-encrypted), and v3
 * (encrypted). Returns null otherwise.
 *
 * The relay's downstream predicates (isPaymentMemo / isBackupMemo / isAckMemo)
 * only inspect `kind` — those work identically on raw v1, v2, and v3 objects,
 * so we DON'T normalize the shape here. Keeping the raw shape lets the caller
 * inspect version-specific fields without conditional ladders.
 *
 * Validation rules:
 *   - Must be valid JSON object
 *   - obj.app === 'iropay'
 *   - obj.kind is a string
 *   - obj.v ∈ {1, 2, 3}
 *   - When v === 3 + kind in {pay, ack}: enc block present + base64-sane
 *     (n, blob_r, blob_s strings of plausible lengths). The relay still
 *     does NOT decrypt — only sanity-checks the envelope.
 */
export function parseIroPayMemo(memoString) {
  if (typeof memoString !== 'string' || memoString.length === 0) return null;

  let obj;
  try {
    obj = JSON.parse(memoString);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== 'object') return null;
  if (obj.app !== APP_NAME) return null;
  if (typeof obj.kind !== 'string') return null;
  if (obj.v !== 1 && obj.v !== 2 && obj.v !== 3) return null;

  // v3 envelope sanity check (relay never decrypts — just verifies the shape).
  if (obj.v === 3 && (obj.kind === 'pay' || obj.kind === 'ack')) {
    if (!isValidEncBlock(obj.enc)) return null;
  }

  return obj;
}

/**
 * Validate a v3 enc block: { n, blob_r, blob_s } all base64 strings of
 * plausible lengths. Used by the relay to reject obviously malformed v3
 * memos before they hit any business logic.
 *
 * Length bounds:
 *   - n is exactly 24 raw bytes → 32 base64 chars
 *   - blob_r / blob_s = box(plaintext, n, ...) = plaintext + 16-byte tag
 *     (NaCl box overhead). Plaintext is ≤ ~120 bytes typical; keep
 *     generous upper bounds so future plaintext additions don't break
 *     validation.
 */
function isValidEncBlock(enc) {
  if (!enc || typeof enc !== 'object') return false;
  if (typeof enc.n !== 'string' || typeof enc.blob_r !== 'string' || typeof enc.blob_s !== 'string') return false;
  if (!isLikelyBase64(enc.n) || !isLikelyBase64(enc.blob_r) || !isLikelyBase64(enc.blob_s)) return false;
  // 24-byte nonce → 32 base64 chars (with no padding optional).
  if (enc.n.length < 24 || enc.n.length > 36) return false;
  // Blobs: at minimum 16 bytes (empty plaintext + auth tag) → ~24 base64 chars.
  // Maximum: ~256 bytes plaintext + 16 = 272 → ~364 base64 chars. Allow ample headroom.
  if (enc.blob_r.length < 20 || enc.blob_r.length > 600) return false;
  if (enc.blob_s.length < 20 || enc.blob_s.length > 600) return false;
  return true;
}

/**
 * Cheap base64-shape predicate: characters are [A-Za-z0-9+/=] only. Doesn't
 * fully validate (we'd need to decode), just rejects obvious garbage.
 */
function isLikelyBase64(s) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/**
 * Predicate: is this a payment memo (kind:"pay")?
 */
export function isPaymentMemo(memo) {
  return !!memo && memo.kind === 'pay';
}

/**
 * Predicate: is this a passkey-link backup memo (kind:"backup")?
 */
export function isBackupMemo(memo) {
  return !!memo && memo.kind === 'backup';
}

/**
 * Predicate: is this a merchant-side payment-attestation memo (kind:"ack")?
 *
 * Ack memos are broadcast by the merchant's client after detecting an
 * incoming payment — they record the verdict (exact / under / over) so
 * future readers can audit the payment match.
 */
export function isAckMemo(memo) {
  return !!memo && memo.kind === 'ack';
}
