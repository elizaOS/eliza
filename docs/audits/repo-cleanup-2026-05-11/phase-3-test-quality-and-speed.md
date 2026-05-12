# Phase 3 Test Quality And Speed

Dry-run only. No implementation files or tests were modified for this audit.

## Guardrails

- Do not mass-delete tests. Broken tests that protect current product behavior should be repaired or re-laned.
- Keep platform, live, real API, and destructive tests if they have an explicit lane and a real owner.
- Only delete tests that are empty, permanently obsolete, or pure runner noise after stronger coverage is identified.
- This audit ran in an already-dirty worktree. Re-run validation from a clean branch before applying cleanup.

## Scan Baseline

Commands used:

```sh
rg --files -g '!**/node_modules/**' -g '!**/.turbo/**' -g '!**/dist/**' -g '!packages/inference/llama.cpp/**' -g '*.{test,spec}.{ts,tsx,js,jsx,mts,cts}'
rg -n -g '*.{test,spec}.{ts,tsx,js,jsx,mts,cts}' "(describe|it|test)\.(skip|todo|only)|\.(skipIf|runIf|fails)\("
rg -n -g '*.{test,spec}.{ts,tsx,js,jsx,mts,cts}' "toMatch(Inline)?Snapshot|toMatchFileSnapshot"
rg -n -g '*.{test,spec}.{ts,tsx,js,jsx,mts,cts}' "setTimeout|waitForTimeout|sleep\("
```

Static signals, excluding `node_modules`, `.turbo`, `dist`, and `packages/inference/llama.cpp`:

| Signal | Count |
| --- | ---: |
| Test/spec files | 1,129 |
| Skip/todo/only/fails-style matches | 164 matches in 92 files |
| Direct `.only` matches | 0 |
| Direct `.todo` matches | 2 |
| `test.fails` matches | 5 in one file |
| Actual snapshot matcher usage | 1 inline snapshot |
| Explicit wait/sleep/timeouts in test files | 288 matches |
| Broad low-value assertion heuristic | 6,037 matches |

The broad low-value assertion count is a triage signal only. Many boolean/null assertions are legitimate branch checks; candidates below are the high-confidence cases.

## Timing And Command Evidence

Targeted commands that produced useful timing or failure output:

| Command | Result |
| --- | --- |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-embedding test __tests__/smoke.test.ts --reporter=verbose` | Passed 1 test in 8.00s. The single import/export smoke test spent 7.82s in tests and 6.11s transform. |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-vision test test/vision-cross-platform.e2e.test.ts --reporter=verbose` | Passed 3, skipped 1 in 8.27s. Import alone took 8.17s; the real model test skipped. |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/ui test src/components/shell/RuntimeGate.cloud-provisioning.test.tsx --reporter=verbose` | Passed 15, skipped 3 in 14.39s. Also emitted React `act(...)` warnings. |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/app-core test scripts/startup-integration-script-drift.test.ts --reporter=verbose` | Skipped 2 tests in 180ms because expected root scripts/workflows are absent. |
| `PATH="$HOME/.bun/bin:$PATH" bun test --cwd cloud --preload ./packages/tests/load-env.ts packages/tests/unit/performance-optimizations.test.ts --timeout 120000` | Passed 30 tests in 1.257s; several tests are source-string checks rather than behavior checks. |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test src/lifeops/scheduled-task/scheduler.test.ts --reporter=verbose` | Failed after 62.02s: 3 failed, 1 skipped. Failure was `ReferenceError: GENERATED_TRANSLATION_PACKS is not defined`. |
| `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-computeruse test test/computeruse.real.e2e.test.ts --reporter=verbose` | Failed immediately with "No test files found"; package config excludes `*.real.e2e.test.ts` and there is no e2e script. |
| `PATH="$HOME/.bun/bin:$PATH" bunx vitest run --config plugins/__tests__/vitest.config.ts plugins/__tests__/setup-routes-contract.test.ts --reporter=verbose` | Failed in 351ms: 19 failed, 10 passed, 7 expected fail. Several `test.fails` cases now pass and therefore fail as stale expected-fail tests. |

## Highest-Value Candidates

### 1. Repair Broken LifeOps Scheduler Tests

Evidence:

- `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts` has 3 runnable tests failing before assertions with `GENERATED_TRANSLATION_PACKS is not defined`.
- The same targeted run took 62.02s and also showed the deliberately skipped concurrency test at `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts:211`.

Recommendation:

- Repair the generated translation pack test setup or plugin init path. Do not delete these tests; they exercise the single `ScheduledTask` runner required by `AGENTS.md`.
- After the harness is repaired, address the skipped Wave 2C concurrency invariant by implementing the single-fire lock or moving it to a tracked failing-contract lane.

Risk:

- High. These tests cover scheduled task firing, pause behavior, and concurrency around the one task primitive.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test src/lifeops/scheduled-task/scheduler.test.ts --reporter=verbose
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test
```

### 2. Repair Stale Connector Setup-Routes Contract Test

Evidence:

- `plugins/__tests__/setup-routes-contract.test.ts` uses `test.fails` at lines 180, 192, 204, 216, and 228.
- Targeted run failed because some expected-fail checks now pass, producing "Expect test to fail".
- The same run reported `plugins/app-documents/src/setup-routes.ts` missing; current route file is `plugins/app-documents/src/routes.ts`.

Recommendation:

- Replace stale `test.fails` cases with normal assertions for connectors that now satisfy the contract.
- Update or remove the stale app-documents path only after confirming the route contract moved to `src/routes.ts`.
- Keep this as a contract test; do not delete it.

Risk:

- High. This protects connector onboarding route shape, but currently gives false-negative noise.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bunx vitest run --config plugins/__tests__/vitest.config.ts plugins/__tests__/setup-routes-contract.test.ts --reporter=verbose
rg -n "test\.fails|plugins/app-documents/src/setup-routes" plugins/__tests__/setup-routes-contract.test.ts
```

### 3. Add A Real Lane For Plugin Computeruse E2E Tests

Evidence:

- `plugins/plugin-computeruse/vitest.config.ts` excludes `**/*.real.e2e.test.{ts,tsx}` and `**/*.e2e.test.{ts,tsx}`.
- `plugins/plugin-computeruse/package.json` only has `test`, not `test:e2e` or `test:live`.
- Running the package script against `test/computeruse.real.e2e.test.ts` returned "No test files found".

Recommendation:

- Add an explicit `test:e2e` or `test:live` script, or teach the config to honor root `VITEST_E2E_ONLY`.
- Keep the real tests gated by env/platform. Repair lane coverage instead of deleting the files.

Risk:

- High. The files look present but are not runnable through the package script.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-computeruse test:e2e --reporter=verbose
TEST_LANE=post-merge PATH="$HOME/.bun/bin:$PATH" node scripts/run-all-tests.mjs --no-cloud --filter='plugin-computeruse' --only=e2e
```

### 4. Repair Skipped RuntimeGate Mobile/Cloud Startup Tests

Evidence:

- `packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx:393`, `:451`, and `:596` are direct `it.skip` tests.
- Targeted run passed 15 and skipped those 3 in 14.39s.
- The same run emitted React `act(...)` warnings in a nearby cloud provisioning test.

Recommendation:

- Repair the skipped tests with updated interactions/fake timers rather than deleting them.
- Fix the `act(...)` warnings while touching the file, because they can hide async state races.

Risk:

- Medium-high. These skipped tests cover Android local choice visibility, iOS remote connection, and async cloud provisioning startup.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/ui test src/components/shell/RuntimeGate.cloud-provisioning.test.tsx --reporter=verbose
rg -n "it\.skip|act\(\.\.\.\)" packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx
```

### 5. Remove Or Rewire Stale Self-Control Startup Drift Tests

Evidence:

- `packages/app-core/scripts/startup-integration-script-drift.test.ts:34` and `:65` use `it.skipIf`.
- `rg -n 'test:selfcontrol|test:startup:contract' package.json .github/workflows` found no current scripts or workflow calls.
- Targeted run skipped both tests.

Recommendation:

- If the self-control startup scripts are obsolete, delete this drift test.
- If the guard still matters, update it to the current script/workflow names and make it fail when the guard is absent.

Risk:

- Medium. As written it provides no signal.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/app-core test scripts/startup-integration-script-drift.test.ts --reporter=verbose
rg -n "test:selfcontrol|test:startup:contract|startup integration script drift" package.json .github/workflows packages/app-core/scripts
```

### 6. Repair Or Retire Group K Affiliate E2E Stubs

Evidence:

- `cloud/apps/api/test/e2e/group-k-affiliate.test.ts:41`, `:52`, and `:65` directly skip auth and happy-path POST coverage.
- The file comment says `/api/affiliate/create-character` is intentionally a 501 stub while R2 image upload is wired.

Recommendation:

- If the affiliate create-character path is still planned, repair the endpoint and enable these tests.
- If the feature is dead, remove the skipped POST tests and the dead endpoint together in a separate product cleanup.

Risk:

- High if the endpoint is still public. Low if product confirms the path is obsolete.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd cloud test:e2e:api -- group-k-affiliate
rg -n "affiliate/create-character|test\.skip" cloud/apps/api cloud/packages/tests
```

### 7. Convert LifeOps E2E Todos Into Owned Tests Or Issues

Evidence:

- `plugins/app-lifeops/test/signature-deadline.e2e.test.ts:147` has an SMS escalation todo.
- `plugins/app-lifeops/test/portal-upload.e2e.test.ts:115` has a full portal form/upload todo.

Recommendation:

- Convert each `it.todo` into a deterministic scenario when the backing scheduler/browser fixtures exist.
- If the work is not scheduled, replace the todo with an issue link in docs and remove the inert test entry.

Risk:

- Medium. Todos are honest but can become permanent noise in e2e reports.

Validation:

```sh
rg -n "it\.todo|test\.todo" plugins/app-lifeops/test
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test -- signature-deadline portal-upload
```

### 8. Split Slow Import-Only Plugin Smoke Tests

Evidence:

- `plugins/plugin-local-embedding/__tests__/smoke.test.ts` only imports the plugin and asserts exported aliases.
- Targeted run took 8.00s for one test.

Recommendation:

- Keep alias/export coverage, but move it to a cheaper static/package-shape check if possible.
- Put the heavy plugin initialization path in the backend/parity suite where the cost buys behavior coverage.

Risk:

- Low-medium. The legacy alias assertion is useful, but the current test is expensive for the signal it provides.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-embedding test __tests__/smoke.test.ts --reporter=verbose
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-embedding test --reporter=verbose
```

### 9. Delete Dummy Skip-Reason Tests After Lane Reporting Is Clear

Evidence:

- `plugins/plugin-vision/test/vision-cross-platform.e2e.test.ts:124` adds a passing test that only asserts `expect(skipModel).toBe(true)` when the model lane is unavailable.
- `plugins/plugin-computeruse/test/computeruse.real.e2e.test.ts:168` does the same for real API/macOS gating.
- The plugin-vision targeted run spent 8.27s importing the file even though the model test skipped.

Recommendation:

- Prefer runner-level skipped test output over extra passing "skip reason recorded" tests.
- Delete only the dummy skip-reason assertions; keep the real gated tests and fixture checks.

Risk:

- Low. This reduces misleading green tests, but keep skip messages discoverable in CI logs.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-vision test test/vision-cross-platform.e2e.test.ts --reporter=verbose
rg -n "expect\(skip|skip-reason recorded|skipped .+ set" plugins/plugin-vision plugins/plugin-computeruse
```

### 10. Replace Source-String Checks With Behavior Or Exported Constants

Evidence:

- `cloud/packages/tests/unit/performance-optimizations.test.ts:521` reads `packages/lib/eliza/plugin-mcp/service.ts` and asserts a literal substring.
- Lines 530-545 regex source text for retry defaults.
- Lines 551-563 assert source contains or omits function names.
- The same file has prompt-template literal checks at lines 465-499.

Recommendation:

- Replace source-text checks with exported constants, public behavior tests, or schema/template snapshot tests with explicit review rules.
- Keep source-string checks only where the code is intentionally enforcing a build-time/source contract.

Risk:

- Medium. Source-string tests are fast, but brittle and easy to satisfy without preserving behavior.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun test --cwd cloud --preload ./packages/tests/load-env.ts packages/tests/unit/performance-optimizations.test.ts --timeout 120000
rg -n "Bun\.file\(|toContain\(|source\.match" cloud/packages/tests/unit/performance-optimizations.test.ts
```

### 11. Replace The Privacy Inline Snapshot With Explicit Field Assertions

Evidence:

- `plugins/app-lifeops/src/lifeops/privacy-egress.test.ts:74` uses the repo's only actual `toMatchInlineSnapshot`.
- The snapshot protects privacy-filtered output shape.

Recommendation:

- Replace the inline snapshot with explicit assertions for `success`, safe `text`, `privacyFiltered`, and absence of original sensitive `data.messageId`.
- Do not delete the test; it protects a privacy boundary.

Risk:

- Medium. Inline snapshots are easy to auto-update past privacy regressions.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test src/lifeops/privacy-egress.test.ts --reporter=verbose
rg -n "toMatchInlineSnapshot|toMatchSnapshot" plugins/app-lifeops/src/lifeops/privacy-egress.test.ts
```

### 12. Delete Or Replace Empty `describe.skip`

Evidence:

- `plugins/plugin-sql/src/__tests__/migration/comprehensive-migration.real.test.ts:157` has `describe.skip("Schema Introspection", () => {})` with only explanatory comments.

Recommendation:

- Delete the empty skipped block if RuntimeMigrator's internal snapshot generator already owns the behavior.
- If schema introspection still needs coverage, replace the empty block with a real migration/introspection assertion.

Risk:

- Low. The current block has no executable value.

Validation:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-sql test -- src/__tests__/migration/comprehensive-migration.real.test.ts
rg -n "describe\.skip\(\"Schema Introspection\"" plugins/plugin-sql/src/__tests__/migration/comprehensive-migration.real.test.ts
```

## Cleanup Order

1. Repair failing tests first: LifeOps scheduler, setup-routes contract, and plugin-computeruse lane coverage.
2. Re-enable skipped user-flow tests where current product behavior exists: RuntimeGate, Group K affiliate, LifeOps Wave 2C.
3. Remove inert skips/todos only after each has an owner decision.
4. Reduce cost/noise: slow import-only smokes, dummy skip-reason tests, source-string checks, and inline snapshots.
5. Delete only empty or obsolete tests after a clean validation run proves stronger coverage remains.

## Suggested Final Validation

```sh
PATH="$HOME/.bun/bin:$PATH" bun run test:lint
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/ui test src/components/shell/RuntimeGate.cloud-provisioning.test.tsx
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/app-lifeops test src/lifeops/scheduled-task/scheduler.test.ts src/lifeops/privacy-egress.test.ts
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-embedding test
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-vision test
PATH="$HOME/.bun/bin:$PATH" bunx vitest run --config plugins/__tests__/vitest.config.ts
PATH="$HOME/.bun/bin:$PATH" bun test --cwd cloud --preload ./packages/tests/load-env.ts packages/tests/unit/performance-optimizations.test.ts --timeout 120000
TEST_LANE=pr PATH="$HOME/.bun/bin:$PATH" node scripts/run-all-tests.mjs --no-cloud --only=test --filter='(packages/ui|plugins/app-lifeops|plugin-local-embedding|plugin-vision|plugin-computeruse)'
```
