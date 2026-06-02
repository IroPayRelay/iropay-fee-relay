// src/info.js
// GET /info — returns the relay's metadata (name, fee-payer wallet, fee policy).
// The PWA client uses this to validate the relay before submitting txs.
//
// Shape MUST stay in sync with the spec (docs/spec.md §3.1). If you add a
// field here, decide whether the client should validate it; if you change
// a field name, update the spec at the same time.

import { configFromRequest } from './config.js';

/**
 * Build the JSON body for /info.
 * Exposed separately from the Response wrapper so tests can assert on the
 * shape directly without parsing JSON.
 */
export function buildInfoBody(request, env) {
  const cfg = configFromRequest(request);
  const paymentCfg = cfg.fees.payment;

  let payment;
  if (paymentCfg.type === 'percent') {
    // v2: declare the fee recipient(s). This reference is a MONO relay — the whole
    // fee goes to YOU (recipients[0].ata = your USDC ATA, bps 10000). To run a
    // 2-recipient sponsor split, declare two entries whose bps sum to 10000 (see
    // docs/spec.md §3.1 + §5) and validate both fee transfers in relay.js.
    payment = {
      type: 'percent', rate: paymentCfg.rate, min: paymentCfg.min,
      recipients: [{ ata: env.FEE_PAYER_USDC_ATA, bps: 10000 }],
    };
  } else if (paymentCfg.type === 'flat') {
    payment = { type: 'flat', amount: paymentCfg.amount };
  } else {
    throw new Error(`Unsupported payment fee type: ${paymentCfg.type}`);
  }

  return {
    version: 2,
    name: cfg.name,
    wallet: env.FEE_PAYER_PUBKEY,
    fees: {
      memo: cfg.fees.memo,
      payment,
    },
    free_cancellation: cfg.free_cancellation,
    supported_actions: ['memo', 'payment'],
  };
}

export function infoHandler(request, env) {
  const body = buildInfoBody(request, env);
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
