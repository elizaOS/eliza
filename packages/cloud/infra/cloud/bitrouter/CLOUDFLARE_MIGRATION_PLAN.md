# Remove BitRouter — Cloudflare Worker is the model gateway

Status: **Phase 1 done (merged); Phase 2/3 in progress** · Updated 2026-06-19

## Target architecture (decided)

**The Cloudflare Worker (`cloud-api`) is the model gateway. Be as direct as
possible — remove servers and hops.**

```
client → cloud-api Worker (CF)
           ├─ native key we hold?  → call that provider DIRECTLY (no hop)
           │     Cerebras · OpenAI · Anthropic · Groq · Vast · (future native keys)
           └─ no native key for it? → OpenRouter (BYOK)   ← the ONLY backup
```

- **Direct-first.** If we have the API key for a model's provider, the Worker
  calls the provider's API directly. No intermediary.
- **OpenRouter is the backup**, used *only* for models we cannot serve natively
  (no native key for that provider) — e.g. a long-tail OpenRouter-catalog model.
- **BitRouter (the separate Railway routing server) is removed entirely.** It
  added a cross-region HTTP hop, a whole service to run/pay for, and a failure
  surface — for routing we can do directly in the Worker.
- **Payment/billing stays in the Worker** (already true): per-request cost is
  computed from `model-id + tokens` against the `ai_pricing` table; usage +
  credit reservation are Worker-side. BitRouter never did billing (its
  auth-proxy only *logged* a redundant Cerebras cost line).

## Routing order (the one rule)

Both `getLanguageModel` (AI-SDK path) and `getProviderForModelWithFallback`
(raw-fetch path) resolve a model in this order:

1. **Groq** native (`groq/*`, + `GROQ_API_KEY`) → Groq direct
2. **Vast** native (`vast/*`) → Vast direct
3. **Cerebras** native (`gpt-oss-120b`, `zai-glm-4.7`, + `CEREBRAS_API_KEY`) → Cerebras direct
4. **OpenAI** native (`openai/*`, + `OPENAI_API_KEY`) → OpenAI direct
5. **Anthropic** native (`anthropic/*`, + `ANTHROPIC_API_KEY`) → Anthropic direct
6. *(future native providers as we add their keys — xAI, Google, … → direct)*
7. **OpenRouter** (BYOK, `OPENROUTER_API_KEY`) → **backup** for everything else
   (no native key: `x-ai/*`, `google/*`, `mistralai/*`, `deepseek/*`, OpenRouter-only
   ids, `:nitro`/`:floor` variants, …)
8. else → clear "not configured" error

Optional resilience (no happy-path cost): a native provider that returns a
*retryable* upstream error (402/429/5xx) may fail over to OpenRouter for the
same model, since OpenRouter mirrors the catalog. This is the existing
`withOpenRouterFallback` wrapper — it only fires on error, adds no hop when the
native call succeeds.

## What changes vs. today

Today BitRouter is the **primary** gateway for every non-native model, reached
by an outbound `fetch` to `https://bitrouter-production.up.railway.app`. We flip
that: native providers become primary and direct; OpenRouter is the only
backup; BitRouter is deleted.

### Phase 1 — DONE (merged: #8728, #8736)
- Native **OpenRouter provider** (`providers/openrouter.ts`) + AI-SDK client.
- OpenRouter wired as the fallback/catch-all; `OPENROUTER_API_KEY` plumbed.
- Billing: OpenRouter-served requests bill under the shared `"bitrouter"` price
  catalog key (OpenRouter == that catalog); `resolveAiProviderSource` returns a
  valid `PricingBillingSource` (no spurious `"openrouter"` member).
- Coverage tests for the OpenRouter-only and raw-fetch-selector paths.

### Phase 2 — flip routing, remove BitRouter from the request path
- `providers/language-model.ts`:
  - Delete the BitRouter client + `getBitRouterLanguageModel` + the
    `getBitRouterApiKey()` primary branch.
  - Order: Groq → Vast → Cerebras → OpenAI(native) → Anthropic(native) →
    OpenRouter(backup). `requiresBitRouterRouting` becomes
    `requiresGatewayRouting` and routes OpenRouter-only ids (`:nitro`/`:floor`,
    `openai/gpt-oss-120b` as an OR id) to OpenRouter, not a native client.
  - `withOpenRouterFallback` generalized to wrap any native primary model.
  - `resolveAiProviderSource`, `hasLanguageModelProviderConfigured`,
    `hasGatewayProviderConfigured`, `getAiProviderConfigurationStatus`,
    `hasAnyAiProviderConfigured`: drop BitRouter.
- `providers/index.ts`: `getProviderForModelWithFallback` primary becomes the
  native provider (OpenAI/Anthropic direct) or OpenRouter; delete
  `getProvider()`/BitRouter singleton. Keep per-family direct providers.
- `providers/bitrouter.ts` + `bitrouter.test.ts` + `language-model-nitro-failover.test.ts`:
  remove (the nitro/`:floor` failover now lives on the OpenRouter path and is
  covered by `openrouter.test.ts`).
- `services/model-catalog.ts`: feed the catalog from **OpenRouter `/v1/models`**
  (the backup catalog) + the static catalog of natively-served models, instead
  of BitRouter `listModels()`. Rename `*BitRouter*` catalog helpers.
- **Preserve** the `zai-glm-4.7` token-floor request fix (today in
  `auth-proxy.mjs`) by applying it in the **Cerebras-direct** request builder in
  the Worker. Drop the redundant Cerebras cost-audit log (Worker pricing is
  authoritative).
- Keep `toBitRouterModelId` / `model-id-translation.ts` **as-is** (it is the
  shared OpenRouter-catalog id normaliser — still correct and used); a rename to
  `toOpenRouterCatalogModelId` is optional cosmetic follow-up.
- Keep `billingSource: "bitrouter"` as the price-catalog key (existing
  `ai_pricing` rows use it; renaming is a risky DB migration, deferred).

### Phase 3 — decommission
- Delete `packages/cloud/infra/cloud/bitrouter/` (Dockerfile, `auth-proxy.mjs`,
  `bitrouter.yaml`, `entrypoint.sh`, `railway.toml`, README) and
  `packages/cloud/infra/tests/bitrouter-service.test.ts`.
- Remove `BITROUTER_API_KEY` / `BITROUTER_BASE_URL` from `cloud/api/wrangler.toml`
  (vars), the secret-push loop in `.github/workflows/cloud-cf-deploy.yml`,
  `types/cloud-worker-env.ts`, and any provider-env reads.
- Update `RAILWAY.md` and `cloud-infra` CLAUDE.md/AGENTS.md (drop the BitRouter
  service row + section).
- **Operator:** ensure `OPENROUTER_API_KEY` secret is set on the Worker (staging
  + prod); deploy; then stop/delete the Railway `bitrouter` service.

## Validation

- Unit: routing-order tests (native-first, OpenRouter-backup), `withOpenRouterFallback`
  on-error failover, raw-fetch selector, OpenRouter-only deployment. Keep the
  whole pricing suite green.
- `bun run --cwd packages/cloud/shared typecheck` and
  `bun run --cwd packages/cloud/api typecheck` clean.
- `bun run --cwd packages/cloud/shared test` (provider + pricing).
- **Staging (operator):** set `OPENROUTER_API_KEY` + native keys, deploy, live
  smoke across Cerebras / OpenAI / Anthropic (direct) + one OpenRouter-only
  model (`x-ai/*` or `google/*`); confirm `usage_records` rows + costs are
  correct; burn-in; then prod + Railway decommission.

## Risks

- **Blast radius = all model routing.** Mitigate: keep `BITROUTER_*` env present
  but unused until the new native+OpenRouter path is proven on staging; remove
  infra only after burn-in.
- **Model-id parity on the backup path.** Confirm OpenRouter (BYOK) actually
  serves the specific ids we route to it (`x-ai/grok-4.20`, `google/*`, …) with
  our key. Native ids are served by their own SDKs (already proven).
- **Catalog completeness.** OpenRouter `/v1/models` ⊇ what BitRouter surfaced;
  merge with the static native catalog as today. Log any dropped models.
