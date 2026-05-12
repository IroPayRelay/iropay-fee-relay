# IroPay Fee Relay — Technical Specification

> Wire protocol for a fee relay compatible with IroPay clients (`iropay.com`).
> Anyone can run a relay. The PWA discovers relays via the user's Settings →
> Fee providers list and selects the active one for submitting transactions.
>
> This document is the **minimal contract**. Anti-spam, reputation, rate
> limits, captchas, and any KV / database choices are entirely up to the
> relay operator and are NOT part of the spec. See the reference impl
> (`relay-worker/` in the iropay/crypto-pay repo) for one production take.

---

## 1. What is a fee relay?

The IroPay PWA is **non-custodial** — the user signs every transaction with
their own Solana keypair. But Solana transactions require a fee payer with
SOL to cover network fees, and a new user has 0 SOL by definition.

A **fee relay** is a third party that:

1. Holds a small SOL balance (~0.05–0.5 SOL is plenty).
2. Acts as the **`fee_payer`** on transactions submitted by IroPay clients.
3. Co-signs the transaction in slot 0 (the user has already partial-signed
   their side as the SPL token authority).
4. Submits the final signed transaction to a Solana RPC.
5. Optionally charges a small USDC fee for payment transactions (the user
   adds an SPL Token Transfer instruction sending USDC to the relay's USDC
   ATA in the same transaction).

Relays are **interchangeable**. The PWA exposes a "Fee providers" screen
where the user can add a new relay URL, switch active relay, or remove
relays. A relay operator gets paid in USDC per payment txn (typical
schedules below); memo-only txns are usually free.

**What the relay does NOT do:**
- Hold user funds (the user's USDC ATA is theirs; the relay only co-signs).
- Decrypt v3 memos (the encryption is end-to-end between sender and receiver).
- Build the transaction (the PWA builds, partial-signs, and serializes).
- Decide where the money goes (the PWA decides recipients; the relay only
  enforces fee-math correctness).

---

## 2. Architecture overview

```
┌─────────────┐   1. GET /info             ┌───────────────┐
│             │  ◄──────────────────────── │               │
│ IroPay PWA  │   2. Build + partial-sign  │  Fee Relay    │
│  (client)   │   3. POST /relay { tx, type}│  (your server)│
│             │  ────────────────────────► │               │
│             │   4. { signature } or err  │               │
│             │  ◄──────────────────────── │               │
└─────────────┘                            └───────┬───────┘
                                                   │ 5. sendTransaction
                                                   │    via Solana RPC
                                                   │    (the relay's RPC,
                                                   │    not the client's)
                                                   ▼
                                           ┌───────────────┐
                                           │ Solana mainnet│
                                           └───────────────┘
```

Steps:

1. **Discover** — Client GETs `/info` to learn the relay's fee policy and
   fee-payer pubkey. Cached client-side.
2. **Build** — Client constructs the transaction with the relay's pubkey
   set as `fee_payer` (slot 0). Adds the appropriate instructions
   (memo, SPL Token Transfers). Adds itself as a signer where needed
   (token transfer authority, optional signed-memo authority). Fetches
   latest blockhash. Partial-signs.
3. **Submit** — Client POSTs the partially-signed transaction (base64) to
   `/relay`.
4. **Validate + co-sign + submit** — Relay parses the tx, validates the
   instruction shape + fee math, signs slot 0 with its fee-payer key,
   submits to Solana RPC, returns the resulting tx signature.
5. **Confirm** — Solana confirms ~400ms later. Client polls
   `getSignatureStatuses` (or just trusts the relay's response and
   moves on).

---

## 3. HTTP API

Two endpoints, both unauthenticated.

### 3.1 `GET /info`

Returns the relay's metadata so the client knows how to build transactions
targeting it.

**Request** — none. Optionally include `Origin` header for CORS.

**Response 200 / `application/json`:**

```jsonc
{
  "version": 1,                  // schema version of this /info shape
  "name": "Fee Relay",            // human-readable label shown in client UI
  "wallet": "FakeP1aceho1d...",      // base58 pubkey, the relay's fee_payer
  "fees": {
    "memo":    0,                // USDC charged per kind:"memo" tx
                                  //   0 = free
                                  //   number = flat USDC per memo
    "payment": {                  // schedule for kind:"payment" txs
      "type": "percent",          // or "flat"
      "rate": 0.01,               // when type=percent → 1%
      "min":  0.01                //   minimum USDC fee (e.g. 1¢)
    }
  },
  "supported_actions": ["payment", "memo"],
  "free_cancellation": true       // (legacy, optional — see note below)
}
```

Variants:

```jsonc
// Flat fee schedule
"payment": { "type": "flat", "amount": 0.001 }   // 0.001 USDC per payment

// Free relay (operator subsidizes everything)
"fees": { "memo": 0, "payment": { "type": "flat", "amount": 0 } }
```

**Headers:**
- `Content-Type: application/json`
- `Access-Control-Allow-Origin: *` (the client is a browser PWA; CORS is required)
- `Cache-Control: no-store` (operators may change fees by redeploying)

**Notes:**
- `free_cancellation` was a v311-era field used when `kind:"req"` memos had
  free cancellation tracking. With the PWA-privacy redesign that retired
  on-chain request memos, the field is effectively unused. Safe to omit
  or set `false`.
- `supported_actions` is informational. The client reads it to grey-out
  options it can't use. Both `"payment"` and `"memo"` are expected for a
  full-featured relay.
- The client uses `wallet` to construct the `fee_payer` slot 0 + the
  recipient `ata` for the fee transfer. **If the relay's wallet doesn't
  have a USDC ATA yet, the PWA will prepend a create-ATA instruction
  in the transaction so the relay pays its own rent.**

---

### 3.2 `POST /relay`

Accepts a partially-signed transaction, co-signs slot 0, submits to RPC.

**Request — `Content-Type: application/json`:**

```jsonc
{
  "tx":   "AQAB...",   // base64 of the serialized partially-signed tx
  "type": "payment"    // or "memo"
}
```

The relay distinguishes two `type` values:

- `"payment"` — the user is sending USDC to a recipient. Tx has memo +
  recipient transfer + fee transfer.
- `"memo"` — the user is broadcasting a record-keeping memo (passkey-link
  backup, ack of received payment). Tx has 1 or 2 memo instructions and an
  optional fee transfer.

**Response 200 / `application/json`:**

```json
{ "signature": "5Hk7uF8YR..." }
```

`signature` is the resulting tx signature on Solana (base58).

**Response 4xx / 5xx / `application/json`:**

```json
{ "error": "Fee payer mismatch" }
```

Or with a structured code:

```json
{ "error": "memo_type_deprecated" }
```

The client surfaces `error` to the user. Stable error codes (when used)
let the client localize the message. Plain error strings are fine for a
new relay.

**Headers:**
- `Content-Type: application/json`
- `Access-Control-Allow-Origin: *`
- The CORS preflight (`OPTIONS /relay`) must respond 200 with
  `Access-Control-Allow-Headers: Content-Type` (plus any custom header
  the client sends, e.g. `X-Turnstile-Token` if the relay uses it).

---

## 4. Transaction shapes

The client builds these. The relay validates them. Knowing exactly what to
expect makes validation a closed set of checks.

### 4.1 Common constants

| Name              | Value                                              |
|-------------------|----------------------------------------------------|
| USDC mint         | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`     |
| USDC decimals     | 6                                                  |
| SPL Memo Program  | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`      |
| Solana cluster    | mainnet-beta                                       |

### 4.2 Payment transaction (`type: "payment"`)

**Instruction layout (in this exact order):**

```
ix[0]  SPL Memo            — JSON memo, kind:"pay" v3 (encrypted). No signers.
ix[1]  SPL Token Transfer  — payer USDC ATA → recipient USDC ATA
                              (the payment itself; amount in raw USDC units)
ix[2]  SPL Token Transfer  — payer USDC ATA → relay USDC ATA
                              (the fee — amount must match the relay's fee
                               policy from /info, see §5)
```

If the recipient's USDC ATA doesn't exist on-chain, a create-ATA instruction
is **prepended** at position 0 (so the actual memo moves to ix[1]). Same
for the relay's USDC ATA — both rent the relay (slot 0).

**Signers:**
- `slot 0`: the relay's fee-payer pubkey — signed BY the relay after `/relay`
- `slot 1`: the payer's pubkey — already signed by the client (partial-sign)

**Memo content** (`ix[0]` data is UTF-8 bytes of this JSON):

```jsonc
{
  "app":  "iropay",
  "kind": "pay",
  "v":    3,
  "amount": 2.16,                // PUBLIC — total USDC paid (top level)
  "req_id": "<8-15 base58>",      // PUBLIC, optional — request nonce
  "enc": {                        // encrypted blob (sender/receiver names,
    "n":      "<base64 24 bytes>",//   local currency amounts). NaCl box +
    "blob_r": "<base64>",          //   x25519. Relay does NOT decrypt.
    "blob_s": "<base64>"
  }
}
```

The relay **only needs to read `amount`, `kind`, and `v`** from this JSON
to validate the tx. It does not (and cannot) read the encrypted fields.

### 4.3 Memo transaction — backup (`type: "memo"`, kind: "backup"`)

Used when the user links a passkey to their seed wallet. The encrypted seed
is broadcast on-chain via a binary memo, findable later via
`getSignaturesForAddress(passkeyPubkey)`.

**Instruction layout:**

```
ix[0]  SPL Memo            — JSON memo, kind:"backup". Signer = owner
                              (the seed wallet) when memo fee = 0.
                              Otherwise no signer required on this memo.
ix[1]  SPL Memo            — Binary base64 blob (the AES-GCM encrypted seed).
                              Signer = passkey wallet (so the tx is findable
                              via getSignaturesForAddress(passkey_pk) later).
ix[2]  SPL Token Transfer  — owner USDC ATA → relay USDC ATA
                              (memo fee — OMITTED entirely when memo fee = 0)
```

When `memo fee = 0` (the default for IroPay's two reference relay modes),
`ix[2]` is removed. To keep the owner's signature attached even without a
fee transfer, the client makes `ix[0]` a **signed memo** with the owner as
the keys-array signer. With a fee transfer present, the owner already
appears via the transfer authority and the JSON memo can be keyless.

**Memo content** (`ix[0]`):

```json
{ "app": "iropay", "kind": "backup", "v": 2 }
```

That's it — a marker. The encrypted payload is in `ix[1]`. Schema version
stays at 2 (passkey backups predate v3 memo encryption and use their own
seed-encryption scheme).

**Signers:**
- slot 0: relay
- slot 1: owner (seed wallet)
- slot 2: passkey wallet (signs the binary blob memo authority)

### 4.4 Memo transaction — ack (`type: "memo"`, kind: "ack"`)

Broadcast by a merchant's PWA after it detects a payment landing. Records
the merchant's match verdict (`"exact"` / `"under"` / `"over"`) so future
auditors can see the payment was acknowledged with the local-currency
amount expected.

**Instruction layout:**

```
ix[0]  SPL Memo            — JSON memo, kind:"ack" v3 (encrypted). Signer =
                              merchant (the initiator), so the tx is
                              findable via getSignaturesForAddress(merchant)
                              when activity-feed enrichment runs later.
ix[1]  SPL Token Transfer  — merchant USDC ATA → relay USDC ATA
                              (memo fee — OMITTED when memo fee = 0)
```

**Memo content** (`ix[0]`):

```jsonc
{
  "app":     "iropay",
  "kind":    "ack",
  "v":       3,
  "amount":  2.16,                 // PUBLIC — USDC received
  "pay_sig": "<base58>",            // PUBLIC — signature of the pay tx
  "req_id":  "<8-15 base58>",       // PUBLIC, optional — propagated
  "match":   "exact",               // PUBLIC — "exact" | "under" | "over"
  "ts":      1715634000,             // PUBLIC — unix seconds
  "enc": { "n": "...", "blob_r": "...", "blob_s": "..." }
}
```

The relay only needs to verify `kind` is one of `{ "backup", "ack" }` (and
optionally `v` matches an expected range). It does NOT decrypt the `enc`
block.

---

## 5. Fee policy

The relay charges a USDC fee for payment txs. Memo txs are typically free
on IroPay's reference relays but a relay operator may charge a flat fee.

### 5.1 Payment fee schedules

Two fee types are supported by the IroPay client. Pick one in `/info`:

**Percent (with minimum):**

```jsonc
"payment": { "type": "percent", "rate": 0.01, "min": 0.01 }
```

For a payment of `amountUsdc`, the fee is:

```
fee = max(min, amountUsdc * rate)
```

The client rounds the fee UP to the nearest cent (0.01 USDC) when type
is `"percent"` — this lets the relay verify exact-match (not approximate)
fee amounts. The reference impl uses `roundUpCentRaw(rawAmount)` in raw
6-decimal units to avoid float arithmetic on the validator.

Example: $2.16 payment, 1% fee, 1¢ min → fee = max(0.01, 0.0216) = 0.0216
→ round up to cent = 0.03 USDC.

**Flat:**

```jsonc
"payment": { "type": "flat", "amount": 0.001 }
```

The fee is always `amount` regardless of payment size. No round-up.

### 5.2 Memo fee

Either:

```jsonc
"memo": 0           // FREE — most relays
"memo": 0.001       // flat USDC per memo tx (rare)
```

When memo fee is 0, the client's tx builder OMITS the fee transfer
instruction (`ix[2]`) from memo txs entirely (see §4.3, §4.4).

### 5.3 Validating fee amounts in the relay

Compute the expected fee yourself using `/info` math, then compare to the
actual `transferAmount` in `ix[N]` (where N is the fee-transfer position).
Reject if not exactly equal (in raw USDC units, no tolerance).

If the client rounds up to the nearest cent, the relay's expected-fee
calculation must do the same.

---

## 6. Validation responsibilities

The relay MUST check, before signing:

1. **Slot 0 = the relay's fee_payer pubkey.** Otherwise reject (`Fee payer
   mismatch`).
2. **Instruction count matches the declared `type`.** Payment = 3 (or 4
   with create-ATA), memo = 1 or 2 (depending on memo fee).
3. **The instructions are in the expected order.** Memo first, then
   transfers.
4. **All transfers use the correct mint** (USDC, see §4.1). Reject txs
   referencing other mints — your relay isn't designed to process them.
5. **The fee transfer amount matches your fee schedule** (see §5.3).
6. **The fee transfer's destination is your relay's USDC ATA.** Reject
   if it goes elsewhere.
7. **The memo's `kind` field matches the declared `type`:**
   - `type:"payment"` → memo kind must be `"pay"`
   - `type:"memo"` → memo kind must be `"backup"` or `"ack"`
8. **The memo's `app` field is `"iropay"`** (or whatever fork identifier
   you accept).

The relay MAY also enforce:
- Schema version (`v`) is in an expected range — useful for forward-compat.
- A blockhash freshness check (most RPCs reject stale blockhashes anyway).
- Sane upper bounds on payment amounts (e.g. reject anything over $X if
  you don't want to handle whale-size payments).

The relay MUST NOT:
- Try to decrypt the `enc` block (it can't — it doesn't have the keys).
- Modify any instruction or memo bytes (the user's signature would invalidate).
- Reorder instructions.
- Add or remove instructions.

The only mutation the relay performs is signing slot 0.

---

## 7. Signing + submission

After validation, the relay:

1. Loads its 32-byte ed25519 secret key (kept in env / secret manager).
2. `nacl.sign.detached(messageBytes, secretBytes)` produces a 64-byte
   signature over the transaction's message bytes (the bytes AFTER the
   signatures array — Solana wire format).
3. Splice the signature into slot 0 of the original tx bytes.
4. Base64-encode the now-fully-signed tx.
5. POST to a Solana RPC's `sendTransaction` method:

```jsonc
{
  "jsonrpc": "2.0",
  "id":      "<random>",
  "method":  "sendTransaction",
  "params":  [
    "<base64 signed tx>",
    {
      "encoding":          "base64",
      "skipPreflight":     true,
      "maxRetries":         0,
      "preflightCommitment": "confirmed"
    }
  ]
}
```

Notes:
- `skipPreflight: true` is the industry standard for SPL token transfers.
  The relay has already validated the tx shape; preflight just duplicates
  the work and adds 1–2s of latency. Use `skipPreflight: false` only for
  manual debugging.
- `maxRetries: 0` is recommended — let the client retry if the tx doesn't
  land. The relay reporting `signature` doesn't promise the tx will land;
  the client should poll `getSignatureStatuses` for confirmation.
- Use a reliable RPC. The reference impl uses Helius
  (`mainnet.helius-rpc.com`). The public Solana RPC blocks Cloudflare
  Workers (403). Triton, Quicknode, Alchemy, and Helius all work well.

---

## 8. Error responses

Return JSON with a top-level `error` field. Use HTTP status codes:

| Status | When |
|--------|------|
| 400 | Bad request (invalid base64, invalid type, validation failed, etc.) |
| 410 | Deprecated type/action (e.g. legacy `cancellation` type) |
| 500 | Relay misconfigured (missing secret, missing RPC, etc.) |
| 502 | Downstream RPC failed |
| 503 | Relay temporarily unavailable |

Example shapes:

```json
{ "error": "Invalid base64 transaction" }
{ "error": "Fee payer mismatch" }
{ "error": "Validation error: payment fee 0.01 does not match expected 0.03" }
{ "error": "Solana submission failed: blockhash not found" }
```

Stable error codes (when used) help the client localize:

```json
{ "error": "cancellation_type_deprecated" }
{ "error": "memo_type_deprecated" }
{ "error": "fee_mismatch" }
```

---

## 9. CORS

The IroPay PWA runs in a browser. Your relay MUST respond to CORS preflight
on `/relay`:

```
OPTIONS /relay HTTP/1.1
Origin: https://iropay.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Content-Type
```

```
HTTP/1.1 200
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

And on every `GET /info` + `POST /relay` response:

```
Access-Control-Allow-Origin: *
```

If the relay sends additional request headers (e.g. an anti-bot token), add
them to `Access-Control-Allow-Headers`.

---

## 10. Worked example — payment of 2.16 USDC, 1% relay

**Step 1 — client GETs `/info`:**

```json
{
  "version": 1,
  "name":    "My Relay",
  "wallet":  "7Euc...",
  "fees":    { "memo": 0, "payment": { "type": "percent", "rate": 0.01, "min": 0.01 } },
  "supported_actions": ["payment", "memo"]
}
```

**Step 2 — client builds the tx:**

- `fee_payer` = `7Euc...`
- ix[0]: memo `{"app":"iropay","kind":"pay","v":3,"amount":2.16,"req_id":"…","enc":{…}}`
- ix[1]: SPL transfer payer-ATA → merchant-ATA, amount = `2.16 * 10^6 = 2_160_000` raw
- ix[2]: SPL transfer payer-ATA → `7Euc...`-USDC-ATA, amount = `0.03 * 10^6 = 30_000`
  raw (max(0.01, 2.16 × 0.01) = 0.0216 → round up to 0.03)
- payer partial-signs, serializes, base64.

**Step 3 — client POSTs:**

```http
POST /relay
Content-Type: application/json

{ "tx": "AQAB...", "type": "payment" }
```

**Step 4 — relay validates:**

- Slot 0 == `7Euc...` ✓
- 3 instructions (no create-ATAs needed) ✓
- ix[0] is memo, `app:"iropay"` and `kind:"pay"` ✓
- ix[1] transfers USDC to merchant ✓
- ix[2] transfers `0.03 USDC` to relay's USDC ATA ✓
- Expected fee = `max(0.01, 2.16 × 0.01) = 0.0216` → round up to 0.03 ✓

**Step 5 — relay signs + submits:**

```json
{ "jsonrpc": "2.0", "id": "1", "method": "sendTransaction", "params": ["...", { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }] }
```

**Step 6 — Helius returns signature:**

```json
{ "jsonrpc": "2.0", "id": "1", "result": "5Hk7uF8YR..." }
```

**Step 7 — relay returns to client:**

```json
{ "signature": "5Hk7uF8YR..." }
```

---

## 11. Reference implementation

The IroPay project ships a production-grade relay in
`relay-worker/` (Cloudflare Worker). MIT-licensed, ~700 LOC including
anti-spam (NOT part of this spec), Turnstile, reputation, cron-driven
auto-refill, and the validation logic above. Useful as a starting point
or to copy specific helpers (parseTransaction, spliceFeePayerSignature,
roundUpCentRaw).

Files of interest:

| File | What's in it |
|------|--------------|
| `src/index.js`  | Request routing (`/info` GET, `/relay` POST, OPTIONS preflight) |
| `src/info.js`   | `buildInfoBody(request, env)` — the `/info` JSON |
| `src/relay.js`  | `relayHandler`, `validatePaymentTx`, `validateMemoTx`, `collectUsdcTransfers`, `floatToRaw`, `computePaymentFeeRaw`, `roundUpCentRaw` |
| `src/solana.js` | `parseTransaction`, `submitToSolana`, `spliceFeePayerSignature`, ed25519 helpers |
| `src/memo.js`   | Memo JSON parsing + kind validation |
| `src/config.js` | Per-host fee schedule (default vs test mode) |

You can host on any platform that gives you HTTPS + a secret key store:
Cloudflare Workers, Fly, Render, Deno Deploy, AWS Lambda, a VPS with
nginx + Node — all fine. The contract is the wire protocol, not the
runtime.

---

## 12. Adding your relay to a client

After your relay is up and responding to `/info`:

1. Open IroPay (`iropay.com`) on a device.
2. Settings → Fee providers → "Add a fee provider".
3. Enter your relay's base URL (e.g. `https://myrelay.example.com`).
4. The PWA fetches `/info`, validates the shape, displays your relay's
   name + fee policy, asks the user to confirm.
5. Tap "Add" → your relay appears in the list. Tap to make it active.

From that point on, every payment + memo broadcast from that user goes
through your relay. The user can switch back to the default IroPay relay
or another provider at any time. The PWA never locks itself to one
provider — that's the decentralization story.

---

## 13. Operating considerations (not part of the spec)

These are out of scope for the wire protocol but useful for operators:

- **SOL balance** — keep ≥ 0.05 SOL on the fee-payer wallet at all times.
  A typical relay burns ~1¢ in SOL fees per 100 transactions; refill from
  surplus USDC via a Jupiter swap when needed.
- **USDC sweeps** — payment fees accumulate. Sweep to a cold wallet
  periodically. Don't keep more than ~$50 USDC on the hot fee-payer.
- **Monitoring** — log every accepted tx (signature, payer, amount, type)
  + every rejection (reason, IP). Helps with debugging "my payment failed"
  reports.
- **Spam protection** — entirely your call. The reference impl uses
  Cloudflare Turnstile (invisible captcha) + per-IP daily quotas + a
  reputation system that gives "credits" to wallets that have paid you
  before. None of this is part of the wire protocol; clients gracefully
  handle whatever you reject.
- **Open-source your relay**. Decentralization narrative is stronger when
  multiple independent operators run interoperable software.

---

## 14. Schema version + future-compat

This spec is `version 1` (see `GET /info`). Future versions will:

- Bump `version` in `/info` to signal new fields.
- Keep `version 1` shape readable as a subset.
- Allow new `type` values in `POST /relay` (relays must reject unknown
  types with a clear 4xx).
- Allow new `kind` values inside memos (relays don't decrypt — they only
  check `kind` is in their allow-list).

Backward compat for clients: a v1 PWA talking to a v2 relay still works
as long as the v2 relay accepts the v1 subset.

---

## License

The IroPay client + reference relay are MIT-licensed. This spec is
public domain — copy it into your own repo and adapt freely.

Contact: contact@iropay.com
