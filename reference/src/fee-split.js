// js/payment/fee-split.js — generic fee + recipient-split math. PURE, no I/O, no imports.
// MUST stay byte-identical in BEHAVIOUR to relay-worker/src/fee-split.js (the relay
// re-derives the split server-side; divergence makes it reject the payment).
//
// All money math is in RAW USDC units (6 decimals, integers). The only float is
// `rate`, applied to an integer raw amount and immediately collapsed via Math.round.
// NO cent round-up (honors sub-cent floors).

function safeRaw(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Total fee in raw units: max(round(amountRaw*rate), minRaw). */
export function computeFeeRaw(amountRaw, rate, minRaw) {
  const amt = safeRaw(amountRaw);
  const r = (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) ? rate : 0;
  const min = safeRaw(minRaw);
  return Math.max(Math.round(amt * r), min);
}

/**
 * Split a total feeRaw across 1 or 2 recipients.
 * @param {number} feeRaw
 * @param {Array<{bps:number, minRaw?:number}>} recipients  1 or 2 entries
 * @returns {number[]} per-recipient cut (raw), same length, summing to feeRaw.
 */
export function splitFeeRaw(feeRaw, recipients) {
  const fee = safeRaw(feeRaw);
  if (!Array.isArray(recipients) || recipients.length === 0) return [fee];
  if (recipients.length === 1) return [fee];
  // 2-recipient: cut0 = min(fee, max(minRaw0, floor(fee*bps0/10000))), cut1 = fee - cut0.
  const r0 = recipients[0] || {};
  const bps0 = (typeof r0.bps === 'number' && r0.bps >= 0) ? r0.bps : 0;
  const min0 = safeRaw(r0.minRaw);
  const cut0 = Math.min(fee, Math.max(min0, Math.floor((fee * bps0) / 10_000)));
  return [cut0, fee - cut0];
}
