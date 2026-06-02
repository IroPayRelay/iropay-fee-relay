# IroPay Fee Relay — Technical Specification (v2)

> Wire protocol for a fee relay compatible with IroPay clients (`iropay.com`).
> Anyone can run a relay. The PWA discovers relays via the user's Settings →
> Payment relays list and selects the active one for submitting transactions.
>
> This document is the **minimal contract**. Anti-spam, reputation, rate
> limits, captchas, and any KV / database choices are entirely up to the
> relay operator and are NOT part of the spec.
>
> **What changed in v2 (2026-06-01 — "generic relays"):** `GET /info` now
> declares its payment fee as **1 or 2 `recipients`** (an atomic fee split, e.g.
> relay 30% + sponsor 70%), and the fee math is **raw-USDC integer, no cent
> round-up**. A v1-style single-recipient relay (no `recipients` field) still
> works — the client keeps a backward-compatible mono path. See §5.

> **Reference implementation — public source (MIT).** A working production-grade
> reference lives in the public GitHub repo:
>
>   ▶ <https://github.com/IroPayRelay/iropay-fee-relay>
>
> There, `reference/` is the Cloudflare-Worker relay and `docs/spec.md` is a copy
> of this spec. Clone it, fill in `reference/wrangler.toml.example`, fund the
> fee-payer with a little SOL, and deploy. Questions: `contact@iropay.com`.

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
5. Optionally charges a small USDC fee for payment transactions. The user
   adds **one SPL Token Transfer per fee recipient** (1 or 2) sending USDC to
   the recipient ATA(s) the relay declares, **in the same transaction**.

Relays are **interchangeable**. The PWA exposes a "Payment relays" screen
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

1. **Discover** — Client GETs `/info` to learn the relay's fee policy
   (incl. its 1–2 fee recipients) and fee-payer pubkey. Cached client-side.
2. **Build** — Client constructs the transaction with the relay's pubkey
   set as `fee_payer` (slot 0). Adds the memo + the recipient transfer + the
   fee transfer(s). Adds itself as a signer where needed (token transfer
   authority, optional signed-memo authority). Fetches latest blockhash.
   Partial-signs.
3. **Submit** — Client POSTs the partially-signed transaction (base64) to
   `/relay`.
4. **Validate + co-sign + submit** — Relay parses the tx, re-derives the fee
   split, validates the instruction shape + fee math, signs slot 0 with its
   fee-payer key, submits to Solana RPC, returns the resulting tx signature.
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
  "version": 2,                   // schema version of this /info shape
  "name": "bobpay",               // human-readable label shown in client UI
  "wallet": "7Euc9sKqj...",       // base58 pubkey, the relay's fee_payer (signs slot 0)
  "fees": {
    "memo": 0,                    // USDC charged per kind:"memo" tx
                                  //   0 = free   |   number = flat USDC per memo
    "payment": {                  // schedule for kind:"payment" txs
      "type": "percent",          // or "flat"
      "rate": 0.01,               // when type=percent → 1% of the payment amount
      "min":  0.01,               // floor on the TOTAL fee (USDC)
      "recipients": [             // 1 or 2 USDC fee destinations — see below
        { "ata": "<relay USDC ATA>",   "bps": 3000, "min_usdc": 0.01 },
        { "ata": "<sponsor USDC ATA>", "bps": 7000 }
      ]
    }
  },
  "supported_actions": ["payment", "memo"],
  "turnstile_sitekey": null       // optional public sitekey, or null / absent
}
```

**`fees.payment.recipients`** — the heart of v2. **1 or 2** entries:

- `recipients[0]` is **always the relay / gas-payer** — the USDC ATA that
  collects this relay's own cut. For a *run-your-own* relay this is just you.
- `recipients[1]` (optional) is a **sponsor / operator** who earns a commission.
- `bps` = share in basis points; the entries **must sum to 10000** (100%).
- `min_usdc` (optional) = a floor on **that recipient's** cut (distinct from
  `payment.min`, which floors the **total** fee).
- **`recipients` is OPTIONAL.** Omit it for a 100%-to-you **mono** relay: the
  client falls back to a single fee transfer to `wallet`'s USDC ATA. This is the
  v1-compatible path — a legacy single-recipient relay keeps working unchanged.

**Variants:**

```jsonc
// Mono relay, 100% of the fee to you (the simplest possible relay)
"payment": { "type": "percent", "rate": 0.01, "min": 0.01,
             "recipients": [ { "ata": "<your USDC ATA>", "bps": 10000 } ] }

// Flat fee (no split, single transfer; no recipients needed)
"payment": { "type": "flat", "amount": 0.001 }

// Free relay (operator subsidizes everything)
"payment": { "type": "percent", "rate": 0, "min": 0.002,
             "recipients": [ { "ata": "<your USDC ATA>", "bps": 10000 } ] }
```

**Headers:**
- `Content-Type: application/json`
- `Access-Control-Allow-Origin: *` (the client is a browser PWA; CORS is required)
- `Cache-Control: no-store` (operators may change fees by redeploying)

**Notes:**
- `supported_actions` is informational. The client reads it to grey-out
  options it can't use. Both `"payment"` and `"memo"` are expected for a
  full-featured relay.
- `turnstile_sitekey` is optional. When present, the client attaches an
  `X-Turnstile-Token` header to free flows (memos / cancellations); see §9.
- The client uses `wallet` to construct the `fee_payer` slot 0. The fee goes
  to the `recipients[].ata` addresses, NOT necessarily `wallet`'s ATA — though
  for a mono relay `recipients[0].ata` IS the relay wallet's own USDC ATA.
- **If a fee-recipient ATA doesn't exist on-chain, the PWA prepends a
  create-ATA instruction so the relay pays its own rent**, and folds a small
  USDC reimbursement for that rent on top of `recipients[0]`'s cut (never a
  separate transfer, never on `recipients[1]`).

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
  recipient transfer + **1 or 2** fee transfers (one per non-zero recipient cut).
- `"memo"` — the user is broadcasting a record-keeping memo (passkey-link
  backup, ack of received payment, settings backup). Tx has 1 or 2 memo
  instructions and an optional single flat memo-fee transfer.

**Response 200 / `application/json`:**

```json
{ "signature": "5Hk7uF8YR..." }
```

`signature` is the resulting tx signature on Solana (base58).

**Response 4xx / 5xx / `application/json`:**

```json
{ "error": "Fee payer mismatch" }
```

The client surfaces `error` to the user. Stable error codes (when used)
let the client localize the message. Plain error strings are fine for a
new relay. The client treats `Insufficient payment fee`, `Missing operator
transfer`, and `Missing our cut transfer` as "refresh /info and retry"
signals (it re-syncs your declared `recipients` and re-builds).

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
| USDC decimals     | 6 (all fee math is in raw integer units)           |
| SPL Memo Program  | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`      |
| Solana cluster    | mainnet-beta                                       |

### 4.2 Payment transaction (`type: "payment"`)

**Instruction layout (in this exact order):**

```
ix[0]  SPL Memo            — JSON memo, kind:"pay" v3 (encrypted). No signers.
ix[1]  SPL Token Transfer  — payer USDC ATA → recipient USDC ATA
                              (the payment itself; amount in raw USDC units)
ix[2]  SPL Token Transfer  — payer USDC ATA → recipients[0].ata
                              (fee cut 0 — the relay's own cut)
ix[3]  SPL Token Transfer  — payer USDC ATA → recipients[1].ata
                              (fee cut 1 — the sponsor cut; PRESENT ONLY when
                               cut1 > 0, see §5)
```

- There is **one fee transfer per recipient whose cut is non-zero**. A **mono**
  relay (single recipient), OR a 2-recipient relay where the 2nd cut rounds to
  0 (below its floor), emits **just `ix[2]`**. A 30/70-style split where both
  cuts are non-zero emits **`ix[2]` + `ix[3]`**.
- If the recipient's USDC ATA and/or a fee-recipient ATA doesn't exist on-chain,
  a create-ATA instruction is **prepended** at position 0 (the memo + transfers
  shift down accordingly). The relay (slot 0) pays that rent; the client folds a
  USDC reimbursement on top of `recipients[0]`'s cut.

**Signers:**
- `slot 0`: the relay's fee-payer pubkey — signed BY the relay after `/relay`.
- `slot 1`: the payer's pubkey — already signed by the client (partial-sign).

**Memo content** (`ix[0]` data is UTF-8 bytes of this JSON):

```jsonc
{
  "app":  "iropay",
  "kind": "pay",
  "v":    3,
  "amount": 2.16,                 // PUBLIC — total USDC paid (top level)
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

### 4.3 Memo transaction — backup (`type: "memo"`, kind: "backup")

Used when the user links a passkey to their seed wallet, or for on-chain
settings backups. The encrypted payload is broadcast on-chain via a binary
memo, findable later via `getSignaturesForAddress(...)`.

**Instruction layout:**

```
ix[0]  SPL Memo            — JSON memo, kind:"backup". Signer = owner
                              (the seed wallet) when memo fee = 0.
                              Otherwise no signer required on this memo.
ix[1]  SPL Memo            — Binary base64 blob (the encrypted payload).
                              Signer = passkey / backup wallet (so the tx is
                              findable via getSignaturesForAddress(...) later).
ix[2]  SPL Token Transfer  — owner USDC ATA → relay USDC ATA
                              (flat memo fee — OMITTED entirely when memo fee = 0)
```

When `memo fee = 0` (the default for IroPay-owned relays), `ix[2]` is removed.
To keep the owner's signature attached even without a fee transfer, the client
makes `ix[0]` a **signed memo** with the owner as the keys-array signer.

The memo fee, when charged, is a **single flat transfer to the relay's USDC
ATA** — it is NOT split across `recipients` (those apply to payment fees only).

**Memo content** (`ix[0]`):

```json
{ "app": "iropay", "kind": "backup", "v": 2 }
```

A marker — the encrypted payload is in `ix[1]`. Schema stays at v2 (backups
use their own seed-encryption scheme, predating v3 memo encryption).

**Signers:** slot 0 = relay, slot 1 = owner, slot 2 = passkey / backup wallet.

### 4.4 Memo transaction — ack (`type: "memo"`, kind: "ack")

Broadcast by a merchant's PWA after it detects a payment landing. Records
the merchant's match verdict (`"exact"` / `"under"` / `"over"`).

**Instruction layout:**

```
ix[0]  SPL Memo            — JSON memo, kind:"ack" v3 (encrypted). Signer =
                              merchant (the initiator), so the tx is findable
                              via getSignaturesForAddress(merchant) later.
ix[1]  SPL Token Transfer  — merchant USDC ATA → relay USDC ATA
                              (flat memo fee — OMITTED when memo fee = 0)
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

The relay only verifies `kind` is one of `{ "backup", "ack" }` (and optionally
`v`). It does NOT decrypt the `enc` block.

---

## 5. Fee policy (v2 — recipient split)

The relay charges a USDC fee for payment txs, **split across its 1–2
`recipients`**. Memo txs are typically free; when charged, the memo fee is a
single flat transfer (not split). **All money math is in raw USDC units (6
decimals, integers). There is NO cent round-up** — sub-cent floors are honored.

> Source of truth: `js/payment/fee-split.js` (client) and
> `reference/src/fee-split.js` (relay) are **byte-identical in behaviour**.
> The relay re-derives the split and rejects any divergence.

### 5.1 Total fee

```
amountRaw = round(amountUsdc * 1e6)        // payment size, raw units
rate      = fees.payment.rate              // e.g. 0.01 for 1%   (0 for a free relay)
minRaw    = round(fees.payment.min * 1e6)  // total-fee floor, raw units

feeRaw    = max( round(amountRaw * rate), minRaw )
```

For a **flat** schedule the total fee is simply `round(amount * 1e6)`, no rate.

### 5.2 Splitting the total across recipients

```
// 1 recipient (mono):
cuts = [ feeRaw ]

// 2 recipients ( [ {bps0, min_usdc0}, {bps1} ] ):
min0  = round(min_usdc0 * 1e6)             // recipient-0 floor, raw (0 if absent)
cut0  = min( feeRaw, max( min0, floor(feeRaw * bps0 / 10000) ) )
cut1  = feeRaw - cut0
cuts  = [ cut0, cut1 ]                      // when cut1 == 0 → emit ONE transfer
```

`recipients[0]` (the relay's own cut) is computed first and floored by its
`min_usdc`; the remainder goes to `recipients[1]`. When the remainder is 0
(a tiny payment where the relay's floor eats the whole fee), only **one** fee
transfer is emitted.

### 5.3 Worked numbers (rate 1%, `recipients: [{bps:3000, min_usdc:0.01}, {bps:7000}]`)

| Payment | `feeRaw` (= max(amt·1%, min)) | split → cuts | fee transfers |
|---------|------------------------------|--------------|---------------|
| **5 USDC**   | max(50000, …) = `50000` (0.05) | cut0 = min(50000, max(10000, 15000)) = `15000` (0.015); cut1 = `35000` (0.035) | **two** → ix[2]=0.015 to r0, ix[3]=0.035 to r1 |
| **0.5 USDC** | max(5000, 10000*) = `10000` (0.01) | cut0 = min(10000, max(10000, 3000)) = `10000`; cut1 = `0` | **one** → ix[2]=0.01 to r0 |

\* with `payment.min = 0.01`. A relay can set a lower `min` (e.g. 0.002).

### 5.4 Memo fee

```jsonc
"memo": 0           // FREE — most relays
"memo": 0.001       // flat USDC per memo tx (rare)
```

When 0, the client OMITS the memo-fee transfer entirely (§4.3, §4.4).

---

## 6. Validation responsibilities

The relay MUST check, before signing:

1. **Slot 0 = the relay's fee_payer pubkey.** Otherwise reject (`Fee payer
   mismatch`).
2. **The instructions match the declared `type` + shape.** Payment = memo +
   recipient transfer + **1 or 2 fee transfers** (+ optional prepended
   create-ATAs); memo = 1 or 2 memos + optional flat fee transfer.
3. **The instructions are in the expected order.** Memo(s) first, then transfers.
4. **All transfers use the correct mint** (USDC, §4.1). Reject other mints.
5. **Re-derive the fee split yourself** from your `/info` (§5) and require
   **one transfer per non-zero cut**, each to the **matching `recipients[i].ata`**,
   with the **exact raw amount** (no tolerance). Reject if a declared cut's
   transfer is missing (`Missing operator transfer` / `Missing our cut
   transfer`) or any amount/destination diverges (`Insufficient payment fee`).
6. **The memo's `kind` matches `type`:** `payment` → `"pay"`; `memo` →
   `"backup"` or `"ack"`.
7. **The memo's `app` field is `"iropay"`** (or your fork identifier).

The relay MAY also enforce: schema version range, blockhash freshness, sane
upper bounds on payment amounts, and — if it pays rent for a create-ATA — that
the fee covers a small reimbursement floor for that rent.

The relay MUST NOT decrypt the `enc` block, modify/reorder/add/remove any
instruction, or touch memo bytes. **The only mutation the relay performs is
signing slot 0.**

---

## 7. Signing + submission

After validation, the relay:

1. Loads its 32-byte ed25519 secret key (env / secret manager).
2. `nacl.sign.detached(messageBytes, secretBytes)` → 64-byte signature over the
   transaction's message bytes (the bytes AFTER the signatures array).
3. Splice the signature into slot 0 of the original tx bytes.
4. Base64-encode the now-fully-signed tx.
5. POST to a Solana RPC's `sendTransaction`:

```jsonc
{
  "jsonrpc": "2.0",
  "id":      "<random>",
  "method":  "sendTransaction",
  "params":  [
    "<base64 signed tx>",
    { "encoding": "base64", "skipPreflight": true, "maxRetries": 0,
      "preflightCommitment": "confirmed" }
  ]
}
```

Notes:
- `skipPreflight: true` is industry standard for SPL token transfers — the relay
  already validated the shape. Use `false` only for manual debugging.
- `maxRetries: 0` — let the client retry. Reporting `signature` doesn't promise
  the tx lands; the client polls `getSignatureStatuses`.
- Use a reliable RPC. The public Solana RPC blocks Cloudflare Workers (403);
  Helius, Triton, QuickNode, Alchemy all work.

---

## 8. Error responses

Return JSON with a top-level `error` field. HTTP status codes:

| Status | When |
|--------|------|
| 400 | Bad request (invalid base64, invalid type, validation/fee-split failure) |
| 410 | Deprecated type/action (e.g. legacy `cancellation`) |
| 500 | Relay misconfigured (missing secret, missing RPC) |
| 502 | Downstream RPC failed |
| 503 | Relay temporarily unavailable |

Example shapes:

```json
{ "error": "Fee payer mismatch" }
{ "error": "Insufficient payment fee: got 10000, need 30000" }
{ "error": "Missing operator transfer (need recipient-1 cut 35000)" }
{ "error": "Solana submission failed: blockhash not found" }
```

The three fee-related strings above are the ones the client recognizes as
"re-sync /info + retry" triggers.

---

## 9. CORS

The IroPay PWA runs in a browser. Your relay MUST answer CORS preflight on
`/relay`:

```
OPTIONS /relay → 200
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Turnstile-Token
```

And send `Access-Control-Allow-Origin: *` on every `GET /info` + `POST /relay`
response. If you declare a `turnstile_sitekey` in `/info`, also accept the
`X-Turnstile-Token` request header (the client attaches it to free flows).

---

## 10. Worked example — payment of 2.16 USDC, 1% relay with a 30/70 split

**Step 1 — client GETs `/info`:**

```json
{
  "version": 2,
  "name":    "My Relay",
  "wallet":  "7Euc...",
  "fees": { "memo": 0, "payment": {
    "type": "percent", "rate": 0.01, "min": 0.01,
    "recipients": [
      { "ata": "RELAYata...", "bps": 3000, "min_usdc": 0.01 },
      { "ata": "SPONSORata...", "bps": 7000 }
    ]
  } },
  "supported_actions": ["payment", "memo"]
}
```

**Step 2 — client computes the fee (raw units, no cent round-up):**

- `amountRaw = 2_160_000`
- `feeRaw = max(round(2_160_000 × 0.01), 10_000) = max(21_600, 10_000) = 21_600` (0.0216 USDC)
- `cut0 = min(21_600, max(10_000, floor(21_600 × 3000/10000))) = min(21_600, max(10_000, 6_480)) = 10_000` (0.01)
- `cut1 = 21_600 − 10_000 = 11_600` (0.0116)

**Step 3 — client builds the tx:**

- `fee_payer` = `7Euc...`
- ix[0]: memo `{"app":"iropay","kind":"pay","v":3,"amount":2.16,…}`
- ix[1]: SPL transfer payer-ATA → merchant-ATA, `2_160_000` raw
- ix[2]: SPL transfer payer-ATA → `RELAYata...`, `10_000` raw (cut0)
- ix[3]: SPL transfer payer-ATA → `SPONSORata...`, `11_600` raw (cut1)
- payer partial-signs, serializes, base64.

**Step 4 — client POSTs** `{ "tx": "AQAB...", "type": "payment" }` to `/relay`.

**Step 5 — relay validates:** slot 0 == `7Euc...` ✓; memo `app:"iropay"`,
`kind:"pay"` ✓; ix[1] pays merchant ✓; re-derives `feeRaw=21_600`,
`[10_000, 11_600]` ✓; ix[2]=10_000→RELAYata ✓; ix[3]=11_600→SPONSORata ✓.

**Step 6 — relay signs slot 0, submits via `sendTransaction`, returns:**

```json
{ "signature": "5Hk7uF8YR..." }
```

(A **mono** relay would declare `recipients: [{ata, bps:10000}]`, the client
would emit a single fee transfer of `21_600` raw, and step 5 would expect one
fee transfer. Everything else is identical.)

---

## 11. Reference implementation

The IroPay project ships a production-grade relay in `reference/`
(Cloudflare Worker). MIT-licensed, includes anti-spam (NOT part of this spec),
Turnstile, reputation, cron-driven auto-refill, and the validation above.

| File | What it does |
|------|--------------|
| reference/src/index.js     | Routing (GET /info, POST /relay, OPTIONS preflight) |
| reference/src/info.js      | buildInfoBody(request, env) — the v2 /info JSON |
| reference/src/relay.js     | relayHandler, validatePaymentTx, validateMemoTx, collectUsdcTransfers |
| reference/src/fee-split.js | computeFeeRaw, splitFeeRaw — the §5 fee math (single source of truth) |
| reference/src/memo.js      | Memo JSON parsing + kind validation |
| reference/src/solana.js    | parseTransaction, submitToSolana, spliceFeePayerSignature |
| reference/src/config.js    | RELAY_CONFIG — edit your name + fee schedule here |

This reference ships a **mono relay** (100% of the fee to you). The 2-recipient
sponsor split documented in §5 is optional — declare two recipients (bps summing
to 10000) in your /info + validate both transfers. Host on anything with HTTPS + a secret store: Cloudflare Workers, Fly, Render,
Deno Deploy, AWS Lambda, a VPS — all fine. The contract is the wire protocol.

The client validates `/info` strictly (`js/wallet/relay-client.js →
validateRelayInfo`) and re-derives the split (`js/payment/fee-split.js`); return
the documented shape or your payments will be rejected.

---

## 12. Adding your relay to a client

1. Open IroPay (`iropay.com`) on a device.
2. Settings → Payment relays → "Add custom relay".
3. Enter your relay's base URL — `https://myrelay.example.com`, or just the
   bare host `myrelay.example.com` (the PWA prepends `https://`), or share a
   `https://iropay.com/?add_relay=myrelay.example.com` link.
4. The PWA fetches `/info`, validates the shape + caps (§13), shows your relay's
   name + fee policy, and asks the user to confirm.
5. Tap "Add" → your relay appears in the list. Tap to make it active.

The user can switch back to a default IroPay relay or another provider at any
time — the PWA never locks itself to one provider.

---

## 13. Caps the client enforces (so you know what gets rejected)

The PWA refuses to **add** a relay whose `/info` declares an abusive fee, and
re-checks on refresh. Stay inside these or your relay won't be addable:

- **Payment rate** ≤ **2%** (`fees.payment.rate ≤ 0.02`). Flat schedules bypass
  the percent cap (a tiny flat fee is fine).
- **Payment floor** `fees.payment.min` ≤ **0.10 USDC** (a high `min` is a
  back-door around the rate cap, so it's bounded).
- **Memo fee** ≤ **0.02 USDC**.
- `recipients`, when present, must be **1 or 2** well-formed entries with valid
  base58 ATAs and `bps` in `[0, 10000]`.

The reference relay re-asserts the same caps server-side (`buildRelayConfig →
assertCapsOrThrow`) so a tampered record is caught both ways.

---

## 14. Operating considerations (not part of the spec)

- **SOL balance** — keep ≥ 0.05 SOL on the fee-payer. A relay burns ~1¢ of SOL
  per ~100 txns; refill from surplus USDC via a Jupiter swap.
- **USDC sweeps** — fees accumulate; sweep to a cold wallet, don't hoard on the
  hot fee-payer.
- **Monitoring** — log accepted txns (sig, payer, amount, type) + rejections
  (reason, IP).
- **Spam protection** — entirely your call (Turnstile, per-IP quotas,
  reputation). None of it is part of the wire protocol; clients gracefully
  handle whatever you reject.
- **Open-source your relay** — the decentralization narrative is stronger with
  multiple independent operators running interoperable software.

---

## 15. Schema version + future-compat

This spec is **`version 2`** (see `GET /info`). The relay declares its version;
clients accept the documented shape.

- **v1 → v2:** v1 declared a single fee schedule with no `recipients` and a
  client-side cent round-up. v2 adds the 1–2 `recipients` split and removes the
  round-up (raw-USDC integer math). A v1-style relay (no `recipients`) still
  works via the client's mono fallback.
- Future versions bump `version`, keep the prior shape readable as a subset,
  allow new `type`/`kind` values (relays reject unknown ones with a clear 4xx),
  and never silently change fee math without a version bump.

---

## 16. Interoperability with other paymasters (Kora & co.)

This spec is a deliberately **minimal REST contract** (two endpoints, a
client-computed USDC fee split). Other Solana gasless/paymaster systems exist
with **different wire protocols** — notably **Kora**
(<https://solana.com/docs/tools/kora>), a JSON-RPC 2.0 paymaster that lets users
pay fees in *any* SPL token, where the **server** estimates the fee
(`estimateTransactionFee` / `getPaymentInstruction`) and signs via
`signAndSendTransaction`.

IroPay does **not** speak the Kora protocol natively: ours is a client-computed
REST contract with a 1–2 recipient USDC split (the split is our revenue model),
USDC-only, with free memos — none of which maps 1:1 onto Kora. We evaluated it
and chose not to adopt it, but the PWA's relay layer could grow a small
**driver adapter** (`KoraDriver`) if there's real demand.

**If you run a Kora node — or any other paymaster — and want it usable from
IroPay, or want to harmonize the two protocols, email
`contact@iropay.com`.** We're happy to look at an adapter.

---

## License

The IroPay client + reference relay are MIT-licensed. This spec is public
domain — copy it into your own repo and adapt freely.

Contact: contact@iropay.com
