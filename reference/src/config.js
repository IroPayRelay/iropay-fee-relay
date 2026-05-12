// src/config.js
// Hardcoded relay-mode configuration. ONE Worker, TWO modes selected per
// request based on the request's hostname.
//
//   feerelayer.net       → 'default' mode (production / IroPay headline relay)
//   test.feerelayer.net  → 'test'    mode (cheap test relay, URL kept underground)
//   anything else        → 'default' (covers localhost, *.workers.dev fallback,
//                                     wrangler dev, preview URLs)
//
// Why hardcoded instead of env vars? With a single Worker, one wrangler.toml,
// and one fee-payer wallet for both hostnames, threading 7 separate
// FEE_*/RELAY_NAME env vars per mode through the config gets messier than just
// stating the schedule in source. The schedule IS the contract — it's read
// often and changes seldom. Edit it here, redeploy, both hostnames pick it up.
//
// Memo fees are 0 for kind:"req" (incl. cancellations) and kind:"backup" on
// BOTH modes. There's no env switch — IroPay's revenue model is the payment
// fee (1% on default / flat 0.001 on test), not the memo fee. A cancellation
// is also free in 'default' mode (free_cancellation:true) since the request
// memo it cancels was itself free.

export const RELAY_CONFIGS = Object.freeze({
  default: {
    // v320: renamed from "IroPay Relay" → "Fee Relay" for friendlier UX.
    // The PWA's DEFAULT_RELAY constant matches this name.
    name: 'Fee Relay',
    fees: {
      memo: 0,                                       // free for req + backup
      payment: { type: 'percent', rate: 0.01, min: 0.01 },
    },
    free_cancellation: true,
  },
  test: {
    name: 'Fee Relay (test)',
    fees: {
      memo: 0,                                       // free for req + backup
      payment: { type: 'flat', amount: 0.001 },     // 0.001 USDC, no min, no round-up
    },
    free_cancellation: false,
  },
});

const HOSTNAME_TO_MODE = Object.freeze({
  'feerelayer.net': 'default',
  'test.feerelayer.net': 'test',
  // anything else → 'default' (see modeFromRequest fallback)
});

/**
 * Resolve a request → mode key ('default' | 'test').
 * Unknown / missing hostnames fall back to 'default' so localhost,
 * preview URLs, and the .workers.dev fallback don't crash.
 */
export function modeFromRequest(request) {
  let hostname;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return 'default';
  }
  return HOSTNAME_TO_MODE[hostname] || 'default';
}

/**
 * Resolve a request → mode config object. Convenience wrapper used by
 * relayHandler + infoHandler.
 */
export function configFromRequest(request) {
  return RELAY_CONFIGS[modeFromRequest(request)];
}
