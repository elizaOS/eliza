# BitRouter → Cloudflare migration plan

Status: **research + plan (awaiting direction decision)** · Author: agent · Date: 2026-06-19

Goal (verbatim intent): move model routing off the separate Railway BitRouter
service, unify it with the rest of the Cloudflare stack so routing runs *inside*
our existing Worker APIs (no extra cross-region API hop), keep it **BYOK-only**
(self-hosted, never BitRouter Cloud), make it work cleanly with Cerebras /
OpenAI / Anthropic, and use **OpenRouter as the fallback when the primary
router fails**. Everything tested, validated, landed.

---

## 1. What we run today (verified against source)

| Piece | Runtime | Path |
|---|---|---|
| `bitrouter serve` + Node `auth-proxy.mjs` | **Railway** (Docker) | `packages/cloud-infra/cloud/bitrouter/` |
| `cloud-api` (Hono) | **Cloudflare Worker** | `packages/cloud-api/` |
| Postgres | **Railway** (Worker reaches it via Hyperdrive binding `HYPERDRIVE`) | prod id `9f59e4ec…` |

Request path for a routed model today:

```
client → cloud-api Worker (CF)  →  fetch https://bitrouter-production.up.railway.app/v1/chat/completions  →  Railway
         (getLanguageModel)         (extra public-internet, cross-region hop)        BitRouter (axum) → Cerebras / OpenRouter
```

Key verified facts:

- **BitRouter is a Rust binary** (`github.com/bitrouter/bitrouter`, Apache-2.0):
  `tokio` (full) + `axum::serve` on a `tokio::net::TcpListener` + `reqwest` +
  `sea-orm`/`sqlx` + a Unix control socket + filesystem config + SQLite wallet
  signing self-issued JWTs. We pin `bitrouter@0.33.0`.
- The npm package is just a `cargo-dist` binary installer — **not a library**.
- **The default user path already bypasses BitRouter.** `getLanguageModel()`
  routes bare `gpt-oss-120b` / `zai-glm-4.7` straight to Cerebras, and
  `openai/*` / `anthropic/*` to native OpenAI/Anthropic clients *when their keys
  are present*. BitRouter is only actually traversed for OpenRouter-catalog
  models (`anthropic/claude-*`, `x-ai/grok-4.20`, `:nitro`/`:floor` variants)
  and legacy gateway-id / apps-chat callers.
  (`packages/cloud-shared/src/lib/providers/language-model.ts`)
- **Pricing/usage is computed Worker-side** from `model id + token usage`
  against the `ai_pricing` table. It does **not** depend on anything BitRouter
  returns. The auth-proxy's `bitrouter_proxy_usage_cost` log is supplementary
  telemetry only. (`services/ai-pricing/*`, `db/repositories/usage-records.ts`)
- **OpenRouter has no direct inference path today.** It is reachable *only*
  through BitRouter. The sole `openrouter.ai` reference in the inference/pricing
  code is the price-catalog fetch (`ai-pricing/providers/openrouter.ts`). So if
  BitRouter is down, there is **no OpenRouter fallback** for chat completions —
  only the prefix-matched OpenAI/Anthropic native clients. **This is a real gap
  vs. the stated goal.**
- The Worker already uses the **Vercel AI SDK** (`@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/gateway`) and already owns a working router
  (`getLanguageModel`) with Cerebras/OpenAI/Anthropic/Groq/Vast native clients,
  transport retry/backoff (`_http.ts`), and `:nitro`/`:floor` failover. **Most
  of "reimplement BitRouter's routing" already exists.**

---

## 2. The three deployment shapes

### Option A — compile BitRouter (Rust) to a Cloudflare Worker (WASM / `workers-rs`)
**Verdict: ruled out. Effectively a rewrite, not a port.**

BitRouter's entire spine is the canonical list of things that do **not** run in
the Workers `wasm32-unknown-unknown` sandbox: `tokio` multi-thread runtime,
`tokio::net::TcpListener` + `axum::serve` (Workers receive `fetch` events, they
don't bind sockets), `reqwest`'s own TCP pool, `sqlx` opening its own
connections (must go through Hyperdrive), bundled C SQLite, a Unix control
socket, and filesystem state. `cloudflare/workers-rs#736` documents exactly this
failure mode for the Axum/Tokio/Reqwest/SQLx stack. The project shows **zero**
WASM/edge intent and is actively coupling *harder* to native/server features
(TEE attestation, on-chain x402 pay, confidential inference). A fork to make it
WASM-compatible is a parallel runtime, i.e. a rewrite. **Do not attempt.**

### Option B — run BitRouter's existing Docker image as a Cloudflare Container
**Verdict: viable, lowest code change, but does not fully meet the stated goal.**

Cloudflare Containers went GA 2026-04-13. We could run the *exact* image we run
on Railway, fronted by a Durable Object, and fold the Node auth-proxy into the
fronting Worker. Pros: zero BitRouter code change; stays on the binary we trust;
keeps OpenRouter-catalog routing + the live `/v1/models` feed exactly as-is.
Cons: it is **still a separate containerized service** — the request path
becomes `Worker → DO → Container → upstream`, the DO/Container/Postgres are
**not guaranteed co-located**, there are cold-starts (need a warm instance), and
it is *not* "inside our existing cloud APIs." It moves the box from Railway to
Cloudflare; it does not remove the box. Pricing is active-CPU per-vCPU/GiB-s.

### Option C — retire BitRouter; route natively inside the cloud-api Worker, OpenRouter as universal BYOK fallback
**Verdict: recommended. Best fit for the literal goal.**

This is the only shape that satisfies "run the routing APIs *inside our existing
cloud APIs* so we don't need another API call to another server in another part
of the world." Because the AI SDK + the existing native clients already do
protocol translation, streaming, and most routing, the remaining work is small
and bounded:

1. **Add a direct OpenRouter provider** (`createOpenAI({ baseURL:
   "https://openrouter.ai/api/v1", apiKey: OPENROUTER_API_KEY })`) — BYOK. This
   is also the no-regret resilience fix (closes the gap in §1).
2. **Re-point the handful of BitRouter-only routes** to native targets:
   `anthropic/claude-*` → native Anthropic (key present) else OpenRouter;
   `x-ai/grok-4.20` and any OpenRouter-catalog pick → OpenRouter directly;
   `gpt-oss-120b` aliases stay Cerebras-direct (already the case).
3. **Make OpenRouter the universal fallback** in `getLanguageModel` /
   `getProviderForModelWithFallback`: native provider first, OpenRouter (BYOK)
   when no native key matches or when the primary returns a retryable error.
   This *is* "OpenRouter is our backup if the (now-native) router can't serve."
4. **Swap the model-catalog feed** from BitRouter `/v1/models` to OpenRouter
   `/api/v1/models` (already fetched for pricing) + the static catalog. Drop the
   BitRouter `listModels` dependency.
5. **Decommission** the Railway BitRouter service + auth-proxy + the
   `bitrouter.yaml` routing config once C is proven in prod. Port the auth-proxy's
   only real value-adds — the `zai-glm-4.7` token-floor request fix and the
   Cerebras cost audit — into the Worker (the token-floor as a request shim, the
   cost audit is already redundant with Worker-side pricing).

What we keep: BitRouter the *config knowledge* (the alias→endpoint table in
`bitrouter.yaml`) becomes native routing rules we already largely encode in
`model-id-translation.ts`.

---

## 3. Recommended path: Option C, phased

**Phase 1 — Native OpenRouter provider + fallback (no-regret; valuable under B *and* C).**
- New `providers/openrouter.ts` (`OpenRouterProvider implements AIProvider`,
  raw-fetch, mirrors `bitrouter.ts`) + a `getOpenRouterLanguageModel` AI-SDK
  client in `language-model.ts`, keyed on `OPENROUTER_API_KEY`.
- Wire it as the fallback in `withProviderFallback` / `getProviderForModelWithFallback`
  and as a catch-all in `getLanguageModel` after the native providers.
- Add `OPENROUTER_API_KEY` to `provider-env`, `cloud-worker-env.ts`,
  `wrangler.toml` secret docs, and the CI secret push list.
- Tests: new `providers/openrouter.test.ts` (same shape as `bitrouter.test.ts`);
  extend `language-model` selection tests; keep the whole existing gate green
  (`bitrouter.test.ts`, `_http.test.ts`, `language-model-nitro-failover.test.ts`,
  `model-id-translation.test.ts`, `ai-pricing/*`).
- **Outcome:** OpenRouter becomes a real fallback *today*, with BitRouter still
  primary. Independently shippable. Reversible.

**Phase 2 — Re-point BitRouter-only routes to native targets; flip default catch-all to OpenRouter.**
- `anthropic/claude-*`, `x-ai/grok-4.20`, OpenRouter-catalog picks → native
  Anthropic / OpenRouter instead of BitRouter.
- Model catalog feed → OpenRouter `/v1/models` + static.
- Behind a config flag so we can A/B and roll back: keep BitRouter reachable but
  demoted to "fallback behind native" until parity is proven.

**Phase 3 — Decommission Railway BitRouter.**
- Port the `zai-glm-4.7` token-floor shim into the Worker request builder.
- Remove `BITROUTER_*` from the hot path; delete the Railway service +
  `bitrouter.yaml` + `auth-proxy.mjs` + the contract test once nothing routes
  through it. Update `RAILWAY.md`.

**Validation each phase:** `bun run --cwd packages/cloud-shared test` (provider +
pricing suites), `bun run --cwd packages/cloud-api typecheck && test:e2e`, then a
staging deploy with a real BYOK OpenRouter key and live chat/apps-chat smoke
across Cerebras + Anthropic + an OpenRouter model, watching billing rows land
correctly in `usage_records`. Five-loop parity check before prod.

---

## 4. Risks + mitigations

- **Production inference is the blast radius.** Mitigate with phasing + a flag:
  Phase 1 only *adds* a fallback (no behavior change for healthy paths); Phase 2
  keeps BitRouter as demoted fallback until parity is proven; Phase 3 removes it
  only after burn-in.
- **OpenRouter feature parity.** Confirm the specific models we route to
  OpenRouter (`anthropic/claude-*`, `x-ai/grok-4.20`) resolve on OpenRouter BYOK
  with our key. Streaming + usage shape already AI-SDK-handled.
- **Billing drift.** Pricing is already Worker-side and model-id-driven, so
  retiring BitRouter does not change cost math. Add OpenRouter as an explicit
  `billingSource` if not already covered; verify `usage_records` rows.
- **`:nitro`/`:floor` semantics.** These are OpenRouter conventions — they
  become *native* OpenRouter routing prefs once we call OpenRouter directly; the
  existing suffix-strip failover (`model-id-translation.ts`) carries over.
- **Catalog gaps.** OpenRouter `/v1/models` is a superset of what BitRouter
  surfaced; merge with the static catalog as today.

## 5. If Option B is chosen instead
Add a `packages/cloud-infra/cloud/bitrouter` Container binding + a fronting
Worker that does auth + proxies to the container `defaultPort` 4356; keep one
warm instance; move secrets from Railway to CF; still do **Phase 1** (native
OpenRouter fallback) because B alone does not give OpenRouter-on-BitRouter-failure.

## 6. Open decision (gates implementation)
Which target architecture: **C** (native routing in the Worker, retire BitRouter)
— recommended; **B** (BitRouter as a CF Container) — lower code change, keeps a
separate service; or **keep BitRouter on Railway for now and only land Phase 1**
(native OpenRouter fallback) as an immediate resilience win. Phase 1 is correct
and worth doing under all three.
