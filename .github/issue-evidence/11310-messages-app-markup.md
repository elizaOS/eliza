# Issue #11310 — `/api/v1/messages` X-App-Id creator markup

## Result

Fixed the `/api/v1/messages` monetized-app path for fresh cross-org callers:
monetized apps are public to authenticated callers for paid inference
attribution, while non-monetized apps remain excluded from this hot path.

## Human-reviewed evidence

- `bun test packages/cloud/api/__tests__/messages-iac-fast-path.test.ts`
  - Passed: 3 tests, 22 assertions.
  - Regression proves a monetized `X-App-Id` request uses
    `appCreditsService.reserveInferenceCredits(...)`, not plain
    `reserveCredits(...)`.
- `bun test packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts`
  - Passed: 21 tests, 89 assertions.
  - Regression proves cross-org authenticated callers resolve monetized apps,
    analytics-only `app_users` rows do not block monetized inference, and
    non-monetized apps still return `undefined`.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bunx @biomejs/biome check packages/cloud/shared/src/lib/services/apps.ts packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts packages/cloud/api/__tests__/messages-iac-fast-path.test.ts packages/test/cloud-e2e/tests/monetized-mock-llm-journey.spec.ts`
  - Passed.
- `bun run --cwd packages/test/cloud-e2e test monetized-mock-llm-journey.spec.ts`
  - Passed: 1 Playwright test.
  - Domain artifacts reviewed from test output and `packages/test/cloud-e2e/.logs/cloud-api.log`:
    - Draft monetization gate returned `403`.
    - Approved monetization update returned `200`.
    - `POST /api/v1/messages` with `X-App-Id` returned `200`.
    - Mock LLM returned `PONG`.
    - End-user org debit: `1000 -> 999.999984` (`0.000015999999959603883` debited).
    - App earnings: `0 -> 0.000008`.

## Validation gaps / non-applicable artifacts

- No screenshots or video: this is a backend billing/API path; no UI surface changed.
- No live-LLM trajectory: the targeted always-on regression is intentionally the
  keyless mock-LLM cloud-e2e path. It drives real cloud-api, PGlite, auth,
  credits, markup, and earnings ledgers; only provider bytes are mocked.
- `bun run --cwd packages/cloud/api typecheck` is blocked by unrelated existing
  cloud-api errors:
  - `__tests__/stripe-connect-webhook-route.test.ts(233,5)` Stripe API version
    literal mismatch.
  - `fal/proxy/route.ts` Hono type mismatch between installed `hono@4.12.18`
    and `hono@4.12.27`.
- `bun run --cwd packages/test/cloud-e2e typecheck` is blocked before source
  checking by `tsconfig.json(15,5): TS5101` because this workspace resolves
  TypeScript 6 and the package still uses deprecated `baseUrl` without
  `ignoreDeprecations`.
- `bun run verify` is blocked before typecheck/lint by unrelated repo-wide
  type-safety ratchet drift:
  - `as unknown as`: `80 current > 77 baseline`.
  - ``?? {}`` in core/agent/app-core: `379 current > 377 baseline`.
