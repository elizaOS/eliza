# @elizaos/plugin-x402

x402 micropayment middleware for elizaOS plugin HTTP routes (HTTP 402 / payment-required).

## Purpose / role

Provides a single integration point for protecting Eliza agent plugin routes behind the [x402 protocol](https://x402.org). Plugin authors declare `x402` on their route definitions; this package handles HTTP 402 negotiation, payment proof verification (on-chain and facilitator-backed), replay protection, and settlement. It is loaded as an opt-in elizaOS plugin (`x402.enabled`) and also importable directly as a middleware library.

This is a **middleware-only plugin**: it registers no actions, providers, evaluators, or services. Its surface is the exported utility functions consumed by the agent HTTP dispatch layer.

## Plugin surface

The `x402Plugin` object (default export) has empty `actions`, `providers`, `evaluators`, and `services` arrays. All runtime behavior is delivered through the exported functions below.

| Export | File | Purpose |
|--------|------|---------|
| `applyPaymentProtection(routes, ctx?)` | `payment-wrapper.ts` | Wraps an array of `Route[]` — routes with `x402` set get a payment-gated handler. Throws on invalid config. |
| `createPaymentAwareHandler(route)` | `payment-wrapper.ts` | Builds the per-route handler that performs 402 negotiation, proof verification, and settlement. |
| `isRoutePaymentWrapped(route)` | `payment-wrapper.ts` | Detects whether HTTP dispatch already wrapped a route (guards against double-wrapping). |
| `X402_ROUTE_PAYMENT_WRAPPED` | `payment-wrapper.ts` | Symbol set on wrapped routes. |
| `resolveEffectiveX402(route, runtime)` | `x402-resolve.ts` | Resolves `x402: true` / partial config against `character.settings.x402` defaults. |
| `X402_EVENT_PAYMENT_REQUIRED` | `x402-resolve.ts` | Event name emitted on 402 response (`"PAYMENT_REQUIRED"`). |
| `X402_EVENT_PAYMENT_VERIFIED` | `x402-resolve.ts` | Event name emitted on successful payment (`"PAYMENT_VERIFIED"`). |
| `validateX402Startup(routes, character?, opts?)` | `startup-validator.ts` | Full startup validation; returns `StartupValidationResult`. |
| `validateAndThrowIfInvalid(routes, character?, opts?)` | `startup-validator.ts` | Same — throws on error. |
| `atomicAmountForPriceInCents(priceInCents, config)` | `payment-config.ts` | Converts integer USD cents to token smallest-unit string (exact rational math). |
| `getPaymentConfig(name, agentId?)` | `payment-config.ts` | Looks up a named payment config (custom then built-in). |
| `registerX402Config(name, config, opts?)` | `payment-config.ts` | Registers a custom payment config at runtime. Throws on duplicate unless `override: true`. |
| `listX402Configs(agentId?)` | `payment-config.ts` | Lists all available config names (built-in + custom). |
| `getX402Health()` | `payment-config.ts` | Returns configured networks and facilitator status. |
| `PAYMENT_CONFIGS` | `payment-config.ts` | Built-in named configs: `base_usdc`, `solana_usdc`, `polygon_usdc`, `bsc_usdc`, `base_elizaos`, `solana_elizaos`, `solana_degenai`. |
| `PAYMENT_ADDRESSES` | `payment-config.ts` | Per-network payout wallet addresses resolved from env (see Config section). |
| `createAccepts(params)` | `x402-types.ts` | Builds and validates an x402 `Accepts` object (x402scan-compliant). |
| `createX402Response(params)` | `x402-types.ts` | Builds and validates an `X402Response`. |
| `validateAccepts(accepts)` | `x402-types.ts` | Validates an `Accepts` object against x402scan schema. |
| `validateX402Response(response)` | `x402-types.ts` | Validates an `X402Response`. |

## Layout

```
src/
  index.ts                    Re-exports all public API; x402Plugin object
  payment-config.ts           Network/token/address registry; PAYMENT_CONFIGS; atomicAmountForPriceInCents
  payment-wrapper.ts          applyPaymentProtection; createPaymentAwareHandler; verifyPayment (all strategies)
  payment-wrapper.test.ts     Unit tests for payment-wrapper
  startup-validator.ts        validateX402Startup; validateAndThrowIfInvalid
  startup-validator.test.ts   Unit tests for startup-validator
  x402-resolve.ts             resolveEffectiveX402; event name constants
  x402-types.ts               Accepts / X402Response types and validators; createAccepts / createX402Response
  x402-standard-payment.ts    Standard X-Payment header decoding; facilitator verify+settle POST helpers
  x402-replay-guard.ts        In-flight + consumed credential guard (TOCTOU prevention)
  x402-replay-durable.ts      runtime.setCache/getCache-backed persistent replay store
  x402-replay-keys.ts         Canonical key derivation from payment proofs / payment IDs
  x402-facilitator-binding.ts Strict/relaxed binding checks on facilitator verify responses
  types.ts                    Internal types (X402Runtime, EIP712*, PaymentVerification*)
  __tests__/                  Additional test suites
```

## Commands

Only scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-x402 build        # compile via build.ts (bun build)
bun run --cwd plugins/plugin-x402 clean        # rm -rf dist
bun run --cwd plugins/plugin-x402 test         # vitest run
bun run --cwd plugins/plugin-x402 typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-x402 lint         # currently aliases typecheck
```

## Config / env vars

All vars are read directly from `process.env`. None are required for the plugin to load; missing payout addresses default to bundled dev examples (startup validator warns/errors in production).

| Env var | Purpose | Required |
|---------|---------|----------|
| `SOLANA_PUBLIC_KEY` or `PAYMENT_WALLET_SOLANA` | Payout wallet on Solana | Recommended |
| `BASE_PUBLIC_KEY` or `PAYMENT_WALLET_BASE` | Payout wallet on Base | Recommended |
| `POLYGON_PUBLIC_KEY` or `PAYMENT_WALLET_POLYGON` | Payout wallet on Polygon | Optional |
| `BSC_PUBLIC_KEY` or `PAYMENT_WALLET_BSC` | Payout wallet on BSC | Optional |
| `X402_FACILITATOR_URL` | Facilitator base URL for payment ID verification and standard payload settle | Optional |
| `X402_FACILITATOR_VERIFY_URL` | Override facilitator verify endpoint (defaults to `X402_FACILITATOR_URL/verify`) | Optional |
| `X402_FACILITATOR_SETTLE_URL` | Override facilitator settle endpoint (defaults to `X402_FACILITATOR_URL/settle`) | Optional |
| `X402_BASE_URL` | Server's own public base URL for resource URLs (default: `https://x402.elizacloud.ai`) | Optional |
| `X402_TEST_MODE` | `"true"` or `"1"` skips all payment verification (dev only; warns in production) | Dev only |
| `X402_REPLAY_DURABLE` | `"0"` / `"false"` / `"off"` disables DB-backed replay store (uses in-memory TTL) | Optional |
| `X402_REPLAY_WINDOW_MS` / `X402_REPLAY_TTL_MS` | In-memory replay TTL in ms (default 600000 / 10 min) | Optional |
| `X402_ALLOW_EIP712_SIGNATURE_VERIFICATION` | `"true"` or `"1"` enables EIP-712 authorization proofs (off by default; see footguns) | Optional |
| `X402_FACILITATOR_RELAXED_BINDING` | `"1"` loosens facilitator response binding checks | Optional |
| `X402_TRUSTED_GATEWAY_SIGNERS` | Comma-separated EVM addresses trusted as X402-Gateway signers | Optional |
| `DEBUG_X402_PAYMENTS` | `"true"` enables verbose debug logging | Dev only |
| `SOLANA_RPC_URL` | Custom Solana RPC (default: mainnet-beta public) | Optional |
| `{NETWORK}_RPC_URL` | Custom EVM RPC per network (e.g. `BASE_RPC_URL`) | Optional |
| `ELIZAOS_PRICE_USD` / `AI16Z_PRICE_USD` / `DEGENAI_PRICE_USD` | USD price per token for atomic amount math (rational, not float) | Optional |

Token price env vars use exact decimal parsing (`atomicAmountForPriceInCents`). All prices in `priceInCents` are integer USD cents.

### Character settings

`x402: true` on a route resolves price and configs from `character.settings.x402`:

```ts
character.settings.x402 = {
  defaultPriceInCents: 10,          // required when using x402: true
  defaultPaymentConfigs: ['base_usdc', 'solana_usdc'],  // required
}
```

## How to extend

### Add a route with x402 in a plugin

```typescript
import { applyPaymentProtection } from '@elizaos/plugin-x402';

export const routes: Route[] = applyPaymentProtection([
  {
    type: 'GET',
    path: '/api/my-paid-resource',
    public: true,
    x402: {
      priceInCents: 10,                         // $0.10
      paymentConfigs: ['base_usdc', 'solana_usdc'],
    },
    handler: async (req, res, runtime) => {
      res.json({ data: 'premium content' });
    },
  },
], { character: runtime.character, agentId: runtime.agentId });
```

### Register a custom payment config

Call `registerX402Config` in your plugin's `init()`:

```typescript
import { registerX402Config } from '@elizaos/plugin-x402';

registerX402Config('mytoken_base', {
  network: 'BASE',
  assetNamespace: 'erc20',
  assetReference: '0x<token-contract>',
  paymentAddress: process.env.BASE_PUBLIC_KEY!,
  symbol: 'MYTOKEN',
  chainId: '8453',
});
```

### Add a new built-in payment config

Edit `src/payment-config.ts`: add token address to the appropriate `*_TOKENS` constant, add an entry to `PAYMENT_CONFIGS`, and add address resolution to `PAYMENT_ADDRESSES` using the same env-var pattern.

### Add a new verification strategy

Edit `verifyPayment` in `src/payment-wrapper.ts`. Each strategy must call `replayGuardTryBegin` before verifying and `replayGuardCommit` on success (or `replayGuardAbortAsync` on failure). Follow the existing pattern — reject early, do not fall through to weaker strategies after a hard failure.

## Conventions / gotchas

- **`x402: true` requires character defaults.** Without `character.settings.x402.defaultPriceInCents` and `defaultPaymentConfigs`, `resolveEffectiveX402` returns `null` and the route responds 500.
- **Replay protection is durable by default.** Consumed credentials are stored via `runtime.setCache`/`getCache` and survive restarts. Set `X402_REPLAY_DURABLE=0` only in tests or dev.
- **EIP-712 proofs are disabled by default.** EIP-712 authorization signatures prove intent but not on-chain settlement; set `X402_ALLOW_EIP712_SIGNATURE_VERIFICATION=1` only if you accept that risk.
- **Bundled example addresses are dev examples only.** If payout env vars are unset, startup validation warns in dev and errors in production (`NODE_ENV=production`).
- **Standard X-Payment payloads (x402-fetch / CDP style) take priority** in `verifyPayment`. A decoded standard payload that fails facilitator verification is rejected outright — it does not fall through to legacy paths.
- **Double-wrap guard.** HTTP dispatch checks `isRoutePaymentWrapped` before calling `createPaymentAwareHandler`; the `X402_ROUTE_PAYMENT_WRAPPED` symbol prevents double-wrapping if routes are processed more than once.
- **Token price math is rational, not float.** `atomicAmountForPriceInCents` uses `BigInt` arithmetic; env price overrides are parsed as exact decimal strings.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — wallet / chain / contracts:**
- On-chain transaction hash(es) + explorer link, wallet balance **before and after**, and the signed-payload/log trail — run against a testnet or fork.
- Revert / insufficient-funds / nonce / gas-estimation-failure paths, and signature-authorization (role/permission) checks.
- The decision trajectory when an agent initiated the on-chain action.
- Never a mocked RPC asserted green — prove the chain state actually changed.
<!-- END: evidence-and-e2e-mandate -->
