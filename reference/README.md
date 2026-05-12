# Reference Implementation — Cloudflare Worker

Minimal IroPay-compatible fee relay, written as a Cloudflare Worker.
~1100 lines including the SPL Token transaction parser. Implements the
wire protocol documented in [`../docs/spec.md`](../docs/spec.md).

**What this includes:**

- `GET /info` endpoint — returns fee policy + relay metadata
- `POST /relay` endpoint — validates, co-signs, submits Solana txs
- Fee math (percent + min, flat) with correct integer arithmetic on raw USDC units
- Manual Solana wire-format parser (no `@solana/web3.js` dep — keeps the Worker
  bundle small)
- ed25519 signing via `tweetnacl`

**What this deliberately does NOT include:**

- Anti-spam (Cloudflare Turnstile, captchas, etc.)
- Per-IP rate limiting / quotas
- Per-wallet reputation systems
- Background cron jobs (auto-refill SOL, auto-extract surplus USDC)
- Monitoring / metrics / alerting

These are operator concerns. Add them according to your needs and stack.
A clear ANTI-SPAM HOOK comment in `src/relay.js` shows where to plug your
own protection in. A POST-SUBMIT HOOK is where to add accounting / logging.

## Deploy

### Prerequisites

1. **A Solana wallet** with ≥ 0.05 SOL on mainnet — this becomes the
   relay's fee-payer. Generate one with any Solana tool:
   ```
   solana-keygen new --outfile relay-fee-payer.json
   ```
   You'll need the **public key** (base58) AND the **secret key as
   64-byte hex**. To convert the JSON keypair file to hex:
   ```
   node -e "console.log(Buffer.from(require('./relay-fee-payer.json')).toString('hex'))"
   ```

2. **A USDC associated token account (ATA)** for the fee-payer wallet on
   mainnet. If your relay wallet has never held USDC, you'll need to
   create it once — send 0.001 USDC from any wallet to the relay's
   pubkey, which auto-creates the ATA. Compute the ATA address with:
   ```
   solana-tokens find-ata <RELAY_PUBKEY> EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   ```

3. **A Solana RPC URL**. The public Solana RPC blocks Cloudflare Workers
   (403). Free-tier options that work: Helius, Triton, QuickNode, Alchemy,
   Syndica. Sign up, get an RPC URL with your API key embedded.

4. **A Cloudflare account** with Workers enabled (free tier is fine for
   < 100k requests/day).

### Configuration

1. Copy `wrangler.toml.example` to `wrangler.toml`:
   ```
   cp wrangler.toml.example wrangler.toml
   ```

2. Edit `wrangler.toml`:
   - `name` — your Worker name
   - `account_id` — your Cloudflare account ID
   - `routes` — your custom domain(s)
   - `HELIUS_RPC` — paste your full RPC URL (with the API key embedded)
   - `FEE_PAYER_PUBKEY` — your relay's base58 pubkey
   - `FEE_PAYER_USDC_ATA` — your relay's USDC ATA address

3. Set the secret (kept in Cloudflare's secret store, NEVER in
   wrangler.toml):
   ```
   wrangler secret put FEE_PAYER_SECRET
   ```
   Paste the 128-character hex string when prompted.

4. (Optional) Edit `src/config.js` to change the fee schedule. Default is
   1% with $0.01 minimum on payments, free memos.

### Install + deploy

```bash
npm install
wrangler deploy
```

After deployment, verify your relay works:

```bash
# /info should return your fee schedule
curl https://your-worker-url.example/info | jq

# Expected output:
# {
#   "version": 1,
#   "name": "My Relay",
#   "wallet": "<your fee-payer pubkey>",
#   "fees": { "memo": 0, "payment": { "type": "percent", "rate": 0.01, "min": 0.01 } },
#   "free_cancellation": false,
#   "supported_actions": ["memo", "payment"]
# }
```

If you see your config echoed back, the relay is live. Add it to your
IroPay client via Settings → Fee providers → Add a fee provider, paste
your Worker URL.

## File map

| File              | Lines | What's in it |
|-------------------|-------|--------------|
| `src/index.js`    | ~50   | Request routing (GET /info, POST /relay, OPTIONS preflight) |
| `src/info.js`     | ~50   | `/info` JSON body |
| `src/config.js`   | ~70   | Fee schedule + relay name (edit to taste) |
| `src/memo.js`     | ~130  | Memo JSON parsing + kind validation |
| `src/solana.js`   | ~230  | Manual wire-format parser, ed25519 helpers, base58, RPC submit |
| `src/relay.js`    | ~540  | Validation + co-sign + submit + error responses |

## Adapting to other stacks

If you don't want Cloudflare Workers, the protocol is platform-agnostic.
The key implementation details to port:

- **HTTP routing** — 2 endpoints, any framework
- **Solana tx parsing** — `src/solana.js` is platform-agnostic vanilla JS
  (no Worker-specific APIs). Copy-paste into Node, Bun, Deno, Cloudflare,
  AWS Lambda, etc.
- **Ed25519 signing** — `tweetnacl` works everywhere; alternatives are
  `@noble/ed25519` (faster, also pure JS) or native bindings
- **Fee math** — all integer arithmetic on raw USDC units (6 decimals).
  Use BigInt to avoid float drift.

## License

MIT — see [`../LICENSE`](../LICENSE).
