# Changelog

All notable engineering changes to this repository are recorded here. For **product-facing** release notes on the docs site, see `packages/content/changelog.mdx`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **OpenRouter model id compatibility (xAI & Mistral)** — Shared helpers in `packages/lib/providers/model-id-translation.ts` (`expandOpenRouterModelIdCandidates`, `normalizeProviderKey`, `canonicalUsageGroupingModel`, `expandPersistedPricingProviderKeys`) plus wiring in catalog lookup, model status, pricing resolution, tiers, usage analytics, and tests. **Why:** OpenRouter catalog ids use `x-ai/` and `mistralai/` while legacy gateway-style ids used `xai/` and `mistral/`; without normalization the same logical model split billing and dashboards, and pricing DB rows keyed under either namespace failed lookups. **Docs:** [docs/openrouter-model-id-compatibility.md](./docs/openrouter-model-id-compatibility.md).
- **Auth API consistency (edge + handlers)** — Many org-scoped and infrastructure routes now use `requireAuthOrApiKeyWithOrg` / `requireAuthOrApiKey` so API keys work end-to-end; `proxy.ts` adds `sessionOnlyPaths` / `sessionOnlyPathPatterns` and rejects API-key-style auth on cookie-only routes with **`401` + `session_auth_required`**. **Why:** Previously the edge let API keys through but cookie-only handlers returned confusing 401s; session-only edge enforcement gives integrators an explicit error. **Docs:** [docs/auth-api-consistency.md](./docs/auth-api-consistency.md), [docs/api-authentication.md](./docs/api-authentication.md). **Note:** `POST /api/crypto/payments` remains session-only; `GET` list accepts API keys. CLI auth: only `POST /api/auth/cli-session` and `GET /api/auth/cli-session/:id` stay public at the edge; `POST .../complete` is no longer under the blanket public prefix (**why:** so session-only rules apply to completion).
- **`session_auth_required`** — New `ApiErrorCode` for proxy JSON errors when a session-only path receives `X-API-Key` or `Bearer eliza_…`. **Why:** Distinguish “no credentials” from “wrong credential type for this endpoint.”
- **Per-agent Anthropic extended thinking** — `user_characters.settings.anthropicThinkingBudgetTokens` (integer ≥ 0) controls thinking for **MCP** and **A2A** agent chat when the model is Anthropic. **`ANTHROPIC_COT_BUDGET_MAX`** optionally caps any effective budget (character or env default). **Why:** Agent owners set policy in stored character data; request bodies must not carry budgets (untrusted MCP/A2A callers). Env still supplies defaults where no character field exists and caps worst-case cost.
- **`ANTHROPIC_COT_BUDGET`** (existing) — Clarified role as **default** when the character omits `anthropicThinkingBudgetTokens` (or value is invalid), plus baseline for routes without a resolved character. **Why:** One deploy-level knob for generic chat; per-agent overrides stay in JSON.
- **`parseThinkingBudgetFromCharacterSettings`**, **`resolveAnthropicThinkingBudgetTokens`**, **`parseAnthropicCotBudgetMaxFromEnv`**, **`ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY`** — See `packages/lib/providers/anthropic-thinking.ts`. **Why:** Single resolution path and a stable settings key for dashboards/APIs.
- **`packages/lib/providers/cloud-provider-options.ts`** — Shared type for merged `providerOptions`. **Why:** Type-safe merges without `any`.
- **`mockAgentPricingMinimumDepositForRouteTests`** — Test helper in `packages/tests/helpers/mock-agent-pricing-for-route-tests.ts`. **Why:** Partial `AGENT_PRICING` mocks broke Agent billing cron under full `bun run test:unit`.

### Changed

- **MCP Google / Microsoft / HubSpot** — Same org burst limit and `apiFailureResponse` as other MCP integrations (were missing Redis org limit and used substring auth detection).
- **Error helpers** — `caughtErrorJson` + `nextJsonFromCaughtError` in `packages/lib/api/errors.ts` (shared body for native `Response` vs `NextResponse`). **My agents** saved + characters list routes use `nextJsonFromCaughtError` instead of `message.includes("auth")`.
- **Rate limit + MCP error DRY** — `packages/lib/middleware/rate-limit.ts` exports `ORGANIZATION_SERVICE_BURST_LIMIT`, `rateLimitExceededPayload` / `rateLimitExceededNextResponse` / `rateLimitExceededResponse`, `mcpOrgRateLimitRedisKey`, and `enforceMcpOrganizationRateLimit`; `withRateLimit` 429 responses use the shared payload. **`packages/lib/api/errors.ts`** adds `apiFailureResponse` for native `Response` catches. Core MCP, integration MCP routes, and A2A org limit reuse the shared burst numbers and canonical 429 / error JSON. **Why:** One definition for 100/min org MCP limits and consistent `rate_limit_exceeded` bodies instead of ad hoc `{ error: "rate_limit_exceeded" }`; auth failures use `ApiError` mapping instead of substring checks on `error.message`.
- **`POST /api/agents/{id}/mcp`** (`chat` tool) and **`POST /api/agents/{id}/a2a`** (`chat`) pass character `settings` into `mergeAnthropicCotProviderOptions`. **Why:** Those routes always resolve a `user_characters` row; other v1 routes remain env-only until a character is available on the request path.
- **Agent billing cron unit tests** — `z-agent-billing-route.test.ts`, queue-backed DB mocks, `package.json` script paths. **Why:** `mock.module` ordering and partial pricing objects caused flaky full-suite failures.

### Documentation

- **`docs/openrouter-model-id-compatibility.md`** — Why gateway vs OpenRouter prefixes exist, where normalization runs (usage SQL `GROUP BY`, pricing, allowlists), and operator checklist to avoid TS/SQL drift.
- **`docs/auth-api-consistency.md`** — Rationale for cookie vs API key, edge session-only lists, CLI session path split, crypto GET/POST split, key-management caveats.
- **`docs/api-authentication.md`** — “Why this model exists” summary and cross-link to consistency doc.
- **`docs/anthropic-cot-budget.md`** — Per-agent settings, env default/max, operator checklist, MCP/A2A scope.
- **`docs/unit-testing-agent-mocks.md`** — Agent `mock.module` pitfalls.
- **`docs/ROADMAP.md`** — Done / near-term items.
