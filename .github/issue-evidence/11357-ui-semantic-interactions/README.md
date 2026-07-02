# Issue 11357 Evidence

Branch: `fix/11357-ui-semantic-interactions`
Base: `origin/develop` at `0d19cc58d073bd6c1d5c84fb41b642ff0a3a6472`

Scope: test-only updates under `packages/app/test/ui-smoke`. No production UI,
agent, prompt, model, connector, or runtime behavior changed.

## Post-Rebase Results

Rebased onto `origin/develop` at
`d861481fd59e82e7cc83a7fc43442b6369250f04` on 2026-07-02.

- PASS: `bun install --frozen-lockfile --ignore-scripts`
- PASS: `bunx @biomejs/biome check packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
- PASS: `git diff --check origin/develop...HEAD -- packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
- PASS: `rg -n "toEqual\(\[\]\)" packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
  - Result: no matches. `rg` exits 1 for no matches.
- PASS: `env ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 bun run --cwd packages/app test:e2e test/ui-smoke/all-views-interaction.spec.ts --project=chromium`
  - Result: `33 passed`
- PASS: `env ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 bun run --cwd packages/app test:e2e test/ui-smoke/all-pages-clicksafe.spec.ts --project=chromium`
  - Result: `102 passed`
- PASS: `bun run verify`
  - Result: Turbo reported `483 successful, 483 total`; repository audits
    passed; `typecheck:dist` checked 28 dist-path consumer configs.

## Results

Initial evidence from the original base follows. The root/package failures below
were pre-existing baseline/workspace issues at that base and are superseded by
the post-rebase pass above.

- PASS: `bun install --frozen-lockfile`
  - Log: `bun-install.log`
- PASS: `bunx @biomejs/biome check packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
  - Log: `biome-check.log`
- PASS: `git diff --check HEAD~1..HEAD -- packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
- PASS: `rg -n "toEqual\(\[\]\)" packages/app/test/ui-smoke/all-views-interaction.spec.ts packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts packages/app/test/ui-smoke/apps-session-route-cases.ts`
  - Result: no matches. `rg` exits 1 for no matches.
- PASS: `env ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 bun run --cwd packages/app test:e2e test/ui-smoke/all-views-interaction.spec.ts --project=chromium`
  - Result: `33 passed`
  - Log: `all-views-interaction.log`
- PASS: `env ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 bun run --cwd packages/app test:e2e test/ui-smoke/all-pages-clicksafe.spec.ts --project=chromium`
  - Result: `102 passed`
  - Log: `all-pages-clicksafe.log`
- FAIL: `bun run --cwd packages/app typecheck`
  - Blocking failures are existing missing workspace package declarations for
    `@elizaos/app-core`, `@elizaos/capacitor-mobile-agent-bridge`, and
    `@elizaos/tui`, plus two existing implicit `any` bridge event parameters.
  - Log: `packages-app-typecheck.log`
- FAIL: `bun run verify`
  - Stops before package checks at `audit:type-safety-ratchet`; current tracked
    production sources exceed the ratchet baseline for `as unknown as` and
    `?? {}` outside the files changed here.
  - Log: `root-verify.log`

## Artifact Applicability

- Screenshots, video walkthrough, and `packages/app audit:app`: N/A - this is a
  smoke-test harness change only. No production UI or rendered pixels changed.
  The browser evidence is the real Chromium Playwright output above.
- Real-LLM trajectories: N/A - no model, prompt, provider, evaluator, or agent
  runtime behavior changed.
- Backend/frontend runtime logs: N/A - no application runtime code path changed;
  the relevant executable artifacts are the Playwright smoke-test logs above.
