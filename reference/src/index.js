// src/index.js
// Cloudflare Worker entry point for an IroPay-compatible fee relay.
//
// Routes:
//   GET  /info  → relay metadata (used by client to discover fee policy)
//   POST /relay → co-sign + submit a Solana transaction
//   OPTIONS *   → CORS preflight
// Everything else returns 404.
//
// This is the MINIMAL reference impl — no anti-spam, no rate limiting,
// no scheduled background jobs. Bring your own protection per the README.

import { infoHandler } from './info.js';
import { relayHandler } from './relay.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/info') {
      return infoHandler(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/relay') {
      return relayHandler(request, env, ctx);
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'access-control-allow-origin': '*' },
    });
  },
};
