# iropay-fee-relay

Wire-protocol specification for a **fee relay** compatible with
[IroPay](https://iropay.com) clients. Anyone can run a relay — IroPay's
PWA discovers relays via the user's Settings → Fee providers list and
selects the active one for submitting transactions.

📘 **[Read the full spec → `docs/spec.md`](docs/spec.md)**

> ⚠️ **Security — co-signing is dangerous.** A relay's fee-payer signature
> authorizes *everything* in a transaction that references its key, not just
> paying gas. A relay that validates only the *fee* can be tricked into co-signing
> a tx that drains its own USDC or SOL. Before signing, you **MUST** run the two
> co-sign-safety checks (program allowlist + "your fee ATA / pubkey is never a
> Token source/authority") — see **[`docs/spec.md` §6.1](docs/spec.md)** and the
> reference `assertCosignSafe` in [`reference/src/relay.js`](reference/src/relay.js).

## What is a fee relay?

The IroPay PWA is non-custodial: users sign every Solana transaction with
their own keypair. But Solana requires a fee payer with SOL to cover
network fees, and a new user has 0 SOL by definition.

A **fee relay** is a third party that:

1. Holds a small SOL balance (~0.05–0.5 SOL is plenty).
2. Acts as the `fee_payer` on transactions submitted by IroPay clients.
3. Co-signs the transaction in slot 0 (the user already partial-signed
   their side as the SPL token authority).
4. Submits the final signed transaction to a Solana RPC.
5. Optionally collects a small USDC fee for payment transactions.

Relays are **interchangeable**. The IroPay client expects only the wire
protocol documented here — no specific implementation, hosting platform,
or anti-spam strategy. Operators can use Cloudflare Workers, AWS Lambda,
Fly, Render, Deno Deploy, or a plain VPS with nginx + Node — all fine.

## Why bother running one?

- **Decentralization** — IroPay shouldn't depend on a single relay
  operator. Multiple independent relays make the payment network resilient
  to any single takedown or operational failure.
- **Revenue** — relays charge a small USDC fee per payment transaction
  (typical: 1% with $0.01 minimum, or a flat $0.001). At ~1k tx/day a
  small relay turns ~$10/day in revenue with ~$0.10/day in SOL costs.
- **Sovereignty** — if you operate a community / merchant network, running
  your own relay means your users pay fees to YOU rather than to a
  third-party operator.

## Wire protocol summary

The protocol has 2 HTTP endpoints (full spec in [`docs/spec.md`](docs/spec.md)):

| Endpoint     | Purpose |
|--------------|---------|
| `GET /info`  | Returns relay metadata: name, fee-payer pubkey, fee schedule |
| `POST /relay`| Accepts a partially-signed Solana tx, validates, co-signs, submits |

### Minimal `/info` response

```json
{
  "version": 1,
  "name": "My Relay",
  "wallet": "FakeP1aceho1d...",
  "fees": {
    "memo": 0,
    "payment": { "type": "percent", "rate": 0.01, "min": 0.01 }
  },
  "supported_actions": ["payment", "memo"]
}
```

### Minimal `/relay` request / response

```http
POST /relay
Content-Type: application/json

{ "tx": "AQAB...", "type": "payment" }
```

```json
{ "signature": "5Hk7uF8YR..." }
```

The relay validates the tx structure (3 specific instructions for a
payment, 2-3 for a memo), checks the fee math, signs slot 0, and submits
to Solana. See the [full spec](docs/spec.md) for instruction layouts,
memo schemas, validation rules, and error responses.

## Quickstart

To stand up a working relay you'll need:

1. **A Solana wallet with ≥ 0.05 SOL** — this becomes your relay's
   fee-payer. Keep the secret key in your hosting platform's secret
   store (Cloudflare secrets, AWS Secrets Manager, Doppler, env vars on
   a hardened VPS — never in source).
2. **A reliable Solana RPC** — the public Solana RPC blocks Cloudflare
   Workers (403 Forbidden). Helius, Triton, QuickNode, Alchemy, and
   Syndica all work well. Free tiers are sufficient at < 1k tx/day.
3. **An HTTPS endpoint** — anywhere that serves HTTP and lets you keep
   secrets. The PWA calls cross-origin so CORS headers are required (see
   spec §9).

Implementation: write the two endpoints per the spec, deploy. ~200–400
LOC of plumbing depending on your language. A working **reference
Cloudflare Worker implementation** is available in
[`reference/`](reference/) — clone, fill `wrangler.toml.example`, and
`wrangler deploy`. ~1100 LOC including the SPL Token tx parser.

## Adding your relay to the IroPay client

Once your relay responds correctly to `GET /info`:

1. Open [iropay.com](https://iropay.com) on a device with a wallet.
2. Settings → Fee providers → "Add a fee provider".
3. Enter your relay's base URL (e.g. `https://myrelay.example.com`).
4. The PWA fetches `/info`, validates the shape, shows your relay's name
   + fee policy, asks the user to confirm.
5. Tap "Add" → your relay appears in the user's relay list. Tap to make
   it active.

From then on, every payment + memo broadcast from that user goes through
your relay. The user can switch back to the default IroPay relay or
another provider at any time.

## Versioning

This specification is **version 1** (see `GET /info`'s `version` field).
Future spec versions will:

- Bump the `version` integer.
- Keep v1 shape readable as a subset (backward-compat).
- Allow new `type` values and `kind` values (relays MUST reject unknown
  types with a clear 4xx).

A v1 PWA client talking to a v2 relay still works as long as the v2 relay
accepts the v1 subset.

## License

This specification is in the public domain — copy it freely into your
own repo and adapt as needed.

The reference implementation in `reference/` is MIT-licensed (see [LICENSE](LICENSE)).

## Contact

- IroPay: <contact@iropay.com>
- Issues / questions about this spec: open a GitHub issue on this repo
