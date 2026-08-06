# Solana Clawd x402

Programmable pay-per-call agents on Solana: one gateway, four payment protocols, one settlement rail, one vault that turns agent usage into on-chain revenue.

This subtree is the full in-repo x402 implementation behind the paid-agent surfaces documented in [`../agents/README.md`](../agents/README.md). If you are starting from an agent definition, use [`../agents/docs/X402_IMPLEMENTATION.md`](../agents/docs/X402_IMPLEMENTATION.md) as the bridge document back into this code.

```text
caller or agent
    |
    | 1. asks for /agents/:id/*
    v
ClawdRouter Worker
    |
    | 2. returns 402 challenge over x402, MPP, or AP2
    v
wallet signs SPL or p-token transfer
    |
    | 3. gateway verifies, settles, receipts, then forwards
    v
upstream agent
    |
    | 4. response returns with payment receipt headers
    v
caller gets the answer
```

## What It Does

Clawd x402 makes AI agents charge for work without accounts, subscriptions, or custodial balances. A caller hits a registered agent, receives a machine-readable `402 Payment Required`, signs a Solana token transfer, and retries the exact request with proof of payment. The gateway verifies the transfer, settles it, writes a receipt, then forwards the paid request to the agent.

The viral hook is simple: every useful API call becomes a collectible, auditable, revenue-bearing event. Agents can sell inference, workflows, search, data, or actions. Holders can get discounts. Owners can earn from usage.

## Moving Parts

| Part | Path | What it does |
| --- | --- | --- |
| Gateway | `worker/src/index.ts` | Cloudflare Worker entrypoint. Routes health, registry reads, facilitator calls, A2A cards, and paid agent invocations. |
| Protocol negotiation | `worker/src/protocols/negotiate.ts` | Decides whether the caller wants x402, MPP, or AP2 based on HTTP headers. |
| x402 adapter | `worker/src/protocols/x402.ts` | Builds `Payment-Required` challenges and emits `Payment-Response` receipts. |
| Solana verifier | `worker/src/solana/x402.ts` | Verifies signed Solana transactions match the challenge: blockhash, mint, destination, amount, and p-token batch outputs. |
| Facilitator | `worker/src/solana/facilitator.ts` | Implements `/verify`, `/settle`, and `/supported` for external x402-compatible servers. |
| Registry client | `worker/src/solana/registry.ts` | Reads Anchor registry accounts and converts them into agent endpoint, pricing, split, protocol, and payout metadata. |
| Revenue math | `worker/src/revenue.ts` | Computes owner, buyback, treasury, and operator split amounts and formats settlement receipts. |
| Holder discounts | `worker/src/clawd.ts` | Checks the payer wallet's `$CLAWD` token balance and discounts the challenge amount by configured tiers. |
| A2A bridge | `worker/src/protocols/a2a.ts` | Wraps Google-style Agent-to-Agent JSON-RPC calls with payment. |
| MPP bridge | `worker/src/protocols/mpp.ts` | Maps `WWW-Authenticate: Payment` flows onto Solana exact payments. |
| AP2 bridge | `worker/src/protocols/ap2.ts` | Verifies AP2 intent mandates before accepting Solana settlement. |
| SDK | `sdk/src/index.ts` | Drop-in `clawdFetch` client. Detects 402, validates challenge, signs the transfer, retries with payment. |
| Vault program | `programs/clawd-vault/src/lib.rs` | Anchor registry and revenue vault. Stores pricing, protocols, split config, and payout recipients. |
| Metaplex agent token | `METAPLEX_AGENT_TOKEN.md` | Launches the canonical token for a registered agent through Metaplex Genesis and routes creator fees to the agent PDA. |

## Hardened In This Pass

| Area | Upgrade |
| --- | --- |
| Discount settlement | The gateway now uses the same discounted amount for both the 402 challenge and settlement verification. |
| Payer binding | If a caller advertises `x-payer` to get a holder discount, the settled transaction must be paid by that wallet. |
| Upstream proxying | Payment credentials and hop-by-hop headers are stripped before forwarding to agents. |
| Endpoint safety | Registered agent endpoints must be HTTPS and cannot target localhost or private IPv4 ranges. |
| A2A parsing | Malformed JSON-RPC requests fail before pricing or settlement. |
| Pricing validation | Zero or negative prices fail closed instead of creating invalid challenges. |
| Registry decoding | Short or malformed registry accounts are rejected. |
| SDK spend control | Clients can set `maxAmount` and `allowedAssets`; the SDK also checks resource, amount, decimals, and batch shape before signing. |
| Vault payouts | Payout authorities are stored in the agent account, and distribution validates every recipient token account before transfer. |
| Rust safety | Split arithmetic now widens before summing, avoiding `u16` overflow behavior. |

## Protocol Flow

### x402

```http
GET /agents/:id/summarize
402 Payment Required
Payment-Required: <base64-json challenge>

GET /agents/:id/summarize
Payment-Signature: <base64 signed Solana transaction>
200 OK
Payment-Response: <base64-json receipt>
```

### MPP

MPP callers receive `WWW-Authenticate: Payment ...` and retry with:

```http
Authorization: Payment method=solana-exact, tx="<base64 signed transaction>"
```

### AP2

AP2 callers attach an intent mandate:

```http
X-AP2-Mandate: <jwt-vc>
Payment-Signature: <base64 signed transaction>
```

The gateway verifies the mandate audience, resource, max amount, expiry, and asset before settlement.

### A2A

A2A agent cards are free to fetch:

```http
GET /a2a/:id/.well-known/agent.json
```

Task calls are paid:

```http
POST /a2a/:id
```

The request body must be JSON-RPC 2.0. Pricing can be keyed by `params.metadata.skillId` or by the A2A method name.

## Revenue Loop

Default split, configurable per agent:

| Recipient | Default | Purpose |
| --- | ---: | --- |
| Agent owner | 70% | Rewards the builder or owner of the registered agent. |
| `$CLAWD` buyback | 15% | Creates protocol-aligned demand from real usage. |
| Treasury | 10% | Funds infra, integrations, audits, and growth. |
| Operator | 5% | Pays the node or facilitator operator. |

The on-chain vault stores payout authorities for buyback, treasury, and operator. Distribution validates token mint and owner on every payout account before moving funds.

## Metaplex Agent Token

Clawd agents can also launch one canonical token through Metaplex Genesis. This is separate from x402 payments: x402 charges for calls, while the Genesis token gives the agent a public market identity and creator-fee stream.

Use `createAndRegisterLaunch` with:

```ts
agent: {
  mint: agentAssetAddress,
  setToken: true,
}
```

That makes Genesis:

| Action | Result |
| --- | --- |
| Creates a bonding curve token | The agent gets a token mint and launch page. |
| Routes creator fees | Fees go to the agent's Core asset signer PDA. |
| Wraps launch transactions | The agent executes the launch onchain through Core execute instructions. |
| Optionally performs first buy | `firstBuyAmount` reserves the initial fee-free swap for the agent PDA. |

Important: `setToken: true` is permanent. Each Metaplex agent can only ever have one agent token; once set, it cannot be changed, replaced, or unset. Use `setToken: false` on devnet or while testing.

See [METAPLEX_AGENT_TOKEN.md](./METAPLEX_AGENT_TOKEN.md) for the full launch flow.

## Holder Discounts

Discounts are applied before the payment challenge is returned.

| `$CLAWD` balance | Discount |
| ---: | ---: |
| `>= 100,000` | 10% |
| `>= 1,000,000` | 25% |
| `>= 10,000,000` | 50% |

The payer must match the wallet used for discount lookup. No borrowed-balance discount spoofing.

## Quick Start

```sh
cd solana-clawd-x402/worker
npm install
npm run typecheck
npx wrangler dev
```

In another project:

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { clawdFetch } from "@solanaclawd/x402-client";

const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=...");
const signer = Keypair.fromSecretKey(secret);

const res = await clawdFetch("https://x402.wtf/agents/<agent-id>/run", {
  method: "POST",
  body: JSON.stringify({ prompt: "ship the thing" }),
  signer,
  connection,
  maxAmount: 10000n,
  allowedAssets: ["<USDC_MINT>"],
});

console.log(await res.text());
console.log(res.signature, res.receiptCid);
```

## Deploy

```sh
cd solana-clawd-x402/worker
npm install
npx wrangler secret put HELIUS_API_KEY
npx wrangler secret put SOLANATRACKER_API_KEY
npx wrangler secret put PINATA_JWT
npx wrangler secret put OPERATOR_KEYPAIR
npx wrangler deploy
```

```sh
cd solana-clawd-x402/programs/clawd-vault
cargo check
anchor build
anchor deploy --provider.cluster mainnet
```

After `anchor build`, replace the placeholder `declare_id!("11111111111111111111111111111111")` with the real deployed program id.

## Environment

| Variable | Purpose |
| --- | --- |
| `NETWORK` | `solana-mainnet` or `solana-devnet`. |
| `TREASURY_OWNER` | Recipient owner for gateway challenge payments. |
| `USDC_MINT` | SPL USDC mint used for default pricing. |
| `CLAWD_MINT` | `$CLAWD` mint used for holder discount lookup. |
| `CLAWD_VAULT_PROGRAM` | Anchor program id for registry and vault accounts. |
| `P_TOKEN_PROGRAM_ID` | Optional p-token program override. |
| `USE_P_TOKEN` | Set to `0` or `false` to force SPL Token transfers. |
| `REGISTRY_SEED` | PDA seed used by the registry client. |
| `PINATA_GATEWAY` | Gateway for manifest and receipt JSON. |
| `SPLIT_*_BPS` | Default revenue split basis points. Must total `10000`. |
| `DISCOUNT_TIER_*` | Holder balance thresholds and discount bps. |
| `HELIUS_API_KEY` | Primary Solana RPC provider. |
| `SOLANATRACKER_API_KEY` | RPC fallback provider. |
| `PINATA_JWT` | Used to pin settlement receipts. |
| `AP2_VERIFIER_JWK` | Public JWK for AP2 mandate verification. |

## Endpoints

| Route | What happens |
| --- | --- |
| `GET /health` | Liveness and network metadata. |
| `GET /registry/:id` | Reads the registered agent account. |
| `POST /facilitator/verify` | Verifies a payment against a challenge. |
| `POST /facilitator/settle` | Re-verifies and broadcasts the payment transaction. |
| `GET /facilitator/supported` | Lists networks, assets, and token programs. |
| `ANY /agents/:id/*` | Payment-gated proxy to the registered agent endpoint. |
| `GET /a2a/:id/.well-known/agent.json` | Free A2A card lookup. |
| `POST /a2a/:id` | Payment-gated A2A JSON-RPC call. |

## Verification

```sh
cd solana-clawd-x402/worker && npm run typecheck
cd solana-clawd-x402/sdk && npm run typecheck
cd solana-clawd-x402/programs/clawd-vault && cargo check
```

Current status: the core gateway, SDK, and vault compile. External production readiness still depends on deployed program ids, real registry entries, funded token accounts, AP2 verifier configuration, and upstream agent endpoints.
