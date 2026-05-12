// src/config.js
// Fee schedule + relay metadata. EDIT THIS to match your relay's policy,
// then redeploy. The PWA client reads /info to discover these values
// (see info.js + the spec doc, §3.1).
//
// This reference impl ships with ONE mode (a single hostname → single
// fee schedule). If you want one Worker to serve multiple hostnames with
// different schedules — useful for a "production" + "test" relay sharing
// the same fee-payer wallet — see the multi-mode variant at the bottom
// of this file.

export const RELAY_CONFIG = Object.freeze({
  // Shown in the IroPay client's "Fee providers" list and on the
  // confirmation modal when a new user adds this relay.
  name: 'My Relay',

  // Fee schedule. Two shapes supported by the spec:
  //   { type: 'percent', rate: 0.01, min: 0.01 }   // 1% with $0.01 min
  //   { type: 'flat',    amount: 0.001 }           // 0.001 USDC flat
  fees: {
    // memo fee charged per kind:"backup" / kind:"ack" memo broadcast.
    // 0 = free. Most production relays set this to 0 — the revenue model
    // is the payment fee, not the memo fee.
    memo: 0,

    // payment fee schedule. See spec §5.1 for the exact math.
    payment: { type: 'percent', rate: 0.01, min: 0.01 },
  },

  // Legacy field — set to false. (Cancellation tracking was retired when
  // request memos moved off-chain in the IroPay protocol; the field
  // remains in the /info schema for forward-compat with older clients.)
  free_cancellation: false,
});

/**
 * Resolve a request → mode config object. The reference is single-mode so
 * this just returns the one config. Replace with the multi-mode variant
 * below if you want hostname-driven mode selection.
 */
export function configFromRequest(_request) {
  return RELAY_CONFIG;
}

// ---------------------------------------------------------------------------
// OPTIONAL — Multi-mode variant.
// Uncomment + adapt to serve different fee schedules on different hostnames
// from the same Worker. Useful when you want a "production" + "test" relay
// without standing up two Workers.
//
// const RELAY_CONFIGS = Object.freeze({
//   default: {
//     name: 'My Relay',
//     fees: { memo: 0, payment: { type: 'percent', rate: 0.01, min: 0.01 } },
//     free_cancellation: false,
//   },
//   test: {
//     name: 'My Relay (test)',
//     fees: { memo: 0, payment: { type: 'flat', amount: 0.001 } },
//     free_cancellation: false,
//   },
// });
//
// const HOSTNAME_TO_MODE = Object.freeze({
//   'myrelay.example.com':      'default',
//   'test.myrelay.example.com': 'test',
// });
//
// export function configFromRequest(request) {
//   let hostname;
//   try { hostname = new URL(request.url).hostname; } catch { return RELAY_CONFIGS.default; }
//   return RELAY_CONFIGS[HOSTNAME_TO_MODE[hostname] || 'default'];
// }
