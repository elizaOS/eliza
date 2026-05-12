# Wave 5 - Test Cleanup Dry Run

Date: 2026-05-11

Scope: dry-run manifest only. No source, config, test, package, asset, or workflow changes are authorized by this document.

## Executive Summary

Wave 5 should make the test suite smaller, more truthful, and easier to lane in CI. The current repo has broad test coverage, but the test surface mixes deterministic unit tests, mocked interaction tests, real/live connector tests, browser smoke specs, benchmark harness tests, package-template tests, and generated or vendored test payloads.

The highest-value cleanup is not mass deletion. It is classification:

- Keep tests that verify contracts, regressions, state transitions, security boundaries, or package templates.
- Convert mocked connector/runtime tests to real mockoon-backed or harness-backed tests where they currently assert mock wiring instead of behavior.
- Move slow, live, benchmark, browser, desktop, local-inference, and DB-heavy suites into explicit lanes with owners and budgets.
- Delete or rewrite tests that are only placeholders, permanently skipped, duplicate a stronger lane, or pass without asserting behavior.
- Promote lane coverage from warn-only inventory to enforced policy after the conversion queue is small enough.

## Inventory Baseline

Inventory was taken with `rg --files` from the current workspace. Counts include untracked files visible to `rg`; the worktree was already dirty before this report. Re-run these counts from a clean branch before applying any cleanup.

| Inventory item | Count | Notes |
| --- | ---: | --- |
| Files visible to `rg --files` | 20,853 | Respecting repo ignore rules. |
| Raw test-like paths | 3,094 | Includes files under `test/`, `tests/`, `__tests__`, helpers, mocks, and named test/spec files. |
| Named test/spec files | 1,373 | `*.test.*`, `*.spec.*`, Python `test_*.py` / `*_test.py`, etc. |
| First-party named test/spec files | 1,345 | Excludes `packages/inference/llama.cpp/**` and `packages/app-core/test/contracts/lib/openzeppelin-contracts/**`. |
| Vendored/submodule named tests | 28 | Keep out of Wave 5 deletion decisions unless ownership is explicit. |
| First-party raw test-like paths | 2,481 | Includes helpers/mocks as well as runnable tests. |

First-party named test files by top-level area:

| Area | Count |
| --- | ---: |
| `packages/` | 628 |
| `plugins/` | 426 |
| `cloud/` | 280 |
| `scripts/` | 10 |
| `test/` | 1 |

First-party named test files by suffix/lane signal:

| Signal | Count |
| --- | ---: |
| Unit/default | 879 |
| Benchmark/performance path | 188 |
| `*.real.test.*` | 75 |
| Integration path/suffix | 74 |
| `*.live.e2e.test.*` | 37 |
| Playwright/spec | 32 |
| `*.e2e.test.*` / `*.e2e.spec.*` | 29 |
| `*.live.test.*` | 20 |
| `*.real.e2e.test.*` | 11 |

Top first-party areas by named test count:

| Area | Count |
| --- | ---: |
| `cloud/packages/tests` | 251 |
| `packages/benchmarks` | 178 |
| `packages/app-core` | 118 |
| `packages/core` | 115 |
| `plugins/app-lifeops` | 108 |
| `plugins/plugin-sql` | 54 |
| `packages/ui` | 49 |
| `packages/training` | 46 |
| `packages/agent` | 39 |
| `packages/shared` | 30 |
| `plugins/plugin-agent-orchestrator` | 28 |
| `plugins/plugin-workflow` | 22 |
| `packages/app` | 21 |

Package script coverage:

| Signal | Count |
| --- | ---: |
| Package manifests scanned | 240 |
| Packages with any `test*` script | 141 |
| Packages with `test` script | 140 |
| Packages with e2e-like script | 20 |
| Packages with local named test files | 117 |
| Test script but no local named test files | 36 |
| Local named test files but no local test script | 12 |

The last two rows are heuristics, not automatic failures. Some packages are intentionally tested by parent runners or template commands.

## Existing Test Architecture

Root orchestration lives in `scripts/run-all-tests.mjs`.

- Default lane is `TEST_LANE=pr`.
- PR lane sets `VITEST_EXCLUDE_REAL_E2E=1`, `VITEST_EXCLUDE_REAL=1`, and `VITEST_LANE=pr`.
- Post-merge lane uses `TEST_LANE=post-merge` and keeps real/live coverage included.
- `--only=test` runs package `test` scripts.
- `--only=e2e` runs package e2e-like scripts and repo `test/vitest/e2e.config.ts` or `live-e2e.config.ts`.
- `TEST_SHARD=N/M` assigns all scripts for a package to the same deterministic shard.
- `TEST_PACKAGE_FILTER`, `TEST_SCRIPT_FILTER`, `--filter`, `--pattern`, and `TEST_START_AT` support focused validation.

Naming conventions are documented in `test/vitest/default.config.ts`:

- `*.test.ts`: unit/default.
- `*.integration.test.ts`: integration.
- `*.e2e.test.ts`: deterministic e2e.
- `*.real.test.ts`: real infra.
- `*.live.test.ts`: live service.
- `*.live.e2e.test.ts` and `*.real.e2e.test.ts`: live/real e2e.
- `*.spec.ts`: Playwright.

Root CI surfaces:

- `.github/workflows/ci.yaml`: build, typecheck, `test:core`, `test:plugins`.
- `.github/workflows/test.yml`: server, client, plugin, Electrobun desktop contract, optional cloud live e2e, final status gate.
- `.github/workflows/cloud-tests.yml`: cloud lint/typecheck/unit/integration/property/runtime/e2e/playwright lanes.
- `.github/workflows/benchmark-tests.yml`: benchmark bridge test and lint lane.
- Additional specialized workflows cover launch QA, lifeops benches, scenario matrices, local inference, packaging, mobile, nightly, and release surfaces.

## Candidate Category 1 - Useless Or Low-Value Tests

Definition: tests that do not assert behavior, are placeholders, are permanently skipped, only prove the test runner works, or duplicate stronger coverage without adding a separate contract.

Inventory signals:

- 2 JS/TS test/spec files had no local assertion pattern.
- 9 trivial assertion lines matched `expect(true).toBe(true)`-style patterns.
- 26 direct `test.skip` / `it.skip` / `describe.skip` lines across 15 files.
- 2 direct `it.todo` lines across 2 files.
- 0 direct `test.only` / `it.only` / `describe.only` matches.

Exact candidates to inspect first:

| Candidate | Signal | Dry-run disposition |
| --- | --- | --- |
| `packages/elizaos/templates/plugin/src/e2e/plugin-starter.e2e.test.ts` | No assertion in wrapper file; delegates to `StarterPluginTestSuite.tests`. | Keep if delegated suite asserts behavior; otherwise convert delegated tests to explicit assertions. |
| `packages/app/test/ui-smoke/ai-qa-capture.spec.ts` | No assertion pattern; writes capture/report artifacts. | Convert to an explicit artifact-generation/manual QA lane or add hard pass/fail checks for issue count, ready state, and screenshot output. |
| `plugins/plugin-sql/src/__tests__/integration/memory.real.test.ts:934` | `expect(true).toBe(true); // Placeholder to avoid empty test`. | Delete or replace with the intended invariant. |
| `plugins/plugin-sql/src/__tests__/integration/log.real.test.ts:78` | Trivial true assertion. | Replace with concrete log persistence assertion or delete block. |
| `plugins/plugin-sql/src/__tests__/migration/production-scenario.real.test.ts:141` | Trivial true assertion. | Replace with concrete migration-state assertion. |
| `plugins/plugin-sql/src/__tests__/migration/runtime-migrator.real.test.ts:480` | Trivial true assertion. | Replace with concrete migrator result assertion. |
| `plugins/plugin-sql/src/__tests__/integration/postgres/pglite-adapter.real.test.ts:59` | Trivial true assertion. | Replace with adapter capability assertion. |
| `plugins/plugin-rlm/__tests__/integration.test.ts:56` | Trivial true assertion. | Replace with Python/RLM availability or behavior assertion. |
| `cloud/packages/tests/runtime/integration/message-handler/mcp-tools.test.ts:476` | Trivial true assertion. | Replace with MCP tracing/status invariant. |
| `cloud/packages/tests/runtime/mcp-assistant-trending.test.ts:317` | Trivial true assertion. | Replace with MCP tracing/status invariant. |
| `cloud/apps/api/test/e2e/group-k-affiliate.test.ts` | Three direct skipped tests. | Broken-but-useful; either enable with required fixture/auth setup or remove if affiliate path is obsolete. |
| `plugins/app-lifeops/test/signature-deadline.e2e.test.ts:147` | `it.todo`. | Convert to deterministic scenario or track as issue with owner. |
| `plugins/app-lifeops/test/portal-upload.e2e.test.ts:115` | `it.todo`. | Convert to deterministic scenario or track as issue with owner. |

Delete criteria:

- The test has no assertion and no delegated suite with assertions.
- The test only asserts the mock was called, without asserting observable state/output.
- The test is permanently skipped and no owner can name the missing fixture, bug, or product surface.
- The test protects code that has been removed or superseded and no package import still reaches it.
- The same behavior is already covered by a stronger contract/e2e test in the same lane.

Keep criteria:

- It documents a public API, frozen contract, security boundary, migration behavior, package template behavior, or user-facing regression.
- It is a smoke/capture test that intentionally produces artifacts and is moved to a manual/reporting lane with explicit output validation.
- It is a platform-specific test gated by runtime conditions and has a matching CI or local validation path.

Convert criteria:

- Placeholder assertion can be replaced by a real invariant in less effort than deleting and recreating later.
- Skipped/todo case maps to a current bug or missing fixture.
- Mock-only test can be moved to harness/mockoon-backed behavior coverage.

## Candidate Category 2 - Mocked Tests

The repo already has `scripts/lint-no-vi-mocks.mjs`. It scans `packages/`, `plugins/`, and `cloud/` test/spec files for `vi.mock`, `vi.fn`, `vi.spyOn`, `vi.mocked`, `mock.module`, Jest mocks, and `as Mock` casts. The script is intentionally failing today and should become a cleanup gate after conversion.

Dry-run scan using the same forbidden pattern family over first-party JS/TS tests:

| Mock signal | Files | Lines |
| --- | ---: | ---: |
| Any forbidden mock signal | 277 | 2,138 |
| `vi.fn(` | 222 | 1,743 |
| `vi.mock(` | 60 | 126 |
| `mock.module(` | 44 | 203 |
| `vi.spyOn(` | 15 | 31 |
| `vi.mocked(` | 15 | 30 |
| `jest.fn(` | 1 | 3 |
| `as Mock` casts | 2 | 2 |

Mock-heavy files to triage first:

| File | Mock lines | Signals |
| --- | ---: | --- |
| `packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx` | 53 | `vi.fn`, `vi.mock` |
| `packages/core/src/runtime/__tests__/planner-loop.test.ts` | 48 | `vi.fn` |
| `packages/app-core/src/api/local-inference-compat-routes.test.ts` | 44 | `vi.fn`, `vi.mock` |
| `plugins/plugin-discord/actions/messageConnector.test.ts` | 42 | `vi.fn` |
| `plugins/plugin-google/src/index.test.ts` | 41 | `vi.fn` |
| `plugins/plugin-form/src/form-plugin.test.ts` | 39 | `vi.fn` |
| `plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts` | 36 | `vi.fn` |
| `plugins/plugin-elizacloud/__tests__/onboarding-failures.test.ts` | 34 | `vi.mock`, `vi.fn`, casts, spies |
| `cloud/packages/tests/unit/docker-node-manager.test.ts` | 32 | `mock.module` |
| `plugins/plugin-agent-skills/src/actions/use-skill.test.ts` | 30 | `vi.mocked`, `vi.fn` |
| `packages/ui/src/api/ios-local-agent-kernel.local-inference.test.ts` | 27 | `vi.fn`, `vi.mock` |
| `plugins/plugin-computeruse/src/__tests__/browser-auto-open.test.ts` | 27 | `vi.mock`, `vi.fn`, `vi.mocked` |
| `plugins/plugin-anthropic/__tests__/native-plumbing.shape.test.ts` | 24 | `vi.fn` |
| `plugins/plugin-telegram/src/messageConnector.test.ts` | 24 | `vi.fn` |
| `packages/app-core/src/api/auth-pairing-routes.test.ts` | 22 | `vi.fn`, `vi.mock`, `vi.spyOn` |
| `packages/core/src/__tests__/message-runtime-stage1.test.ts` | 21 | `vi.fn` |
| `packages/core/src/features/payments/actions/deliver-payment-link.test.ts` | 21 | `vi.fn` |
| `plugins/plugin-roblox/__tests__/integration.test.ts` | 21 | `vi.fn`, `vi.mocked` |
| `packages/agent/src/api/connector-account-routes.test.ts` | 20 | `vi.mock`, `vi.fn` |
| `plugins/app-lifeops/src/lifeops/runtime-service-delegates.test.ts` | 20 | `vi.fn` |
| `plugins/plugin-lmstudio/__tests__/text.shape.test.ts` | 20 | `vi.fn`, `vi.mock` |
| `plugins/plugin-slack/src/messageConnector.test.ts` | 20 | `vi.fn` |
| `plugins/plugin-whatsapp/__tests__/message-connector.test.ts` | 20 | `vi.fn` |

Keep mocked tests only when:

- The mock is a local fake for a pure domain boundary and the assertion is on returned state, emitted event, serialized payload, or durable side effect.
- The mocked dependency is nondeterministic or unavailable in CI, and the test also has a higher-lane real/live counterpart.
- The test is a fast regression for a branch explosion where a real harness would be disproportionately slow.

Convert mocked tests when:

- The subject is a connector, channel dispatch, route, persistence adapter, runtime service, LLM provider, or scheduler runner.
- Assertions are about whether a fake method was called instead of the externally visible behavior.
- The mock replaces HTTP, DB, auth, desktop, browser, or queue behavior that can be represented by mockoon, PGlite, local server fixtures, or typed in-memory stores.
- A LifeOps test verifies behavior through text prompt content rather than structural `ScheduledTask` fields. LifeOps tests should assert `kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`, `output`, `subject`, `priority`, and `respectsGlobalPause` behavior, not `promptInstructions` text.

Delete mocked tests when:

- The only assertion is call count or called-with on a mock and a behavior-level test already exists.
- The mocked dependency shape no longer matches production and the test is preserving old coupling.
- The test is effectively a type-level compile check already covered by `typecheck`.

## Candidate Category 3 - Slow Tests

Slow-test candidates were identified by file naming, imports, and content signals. These counts are risk signals, not measured runtime.

| Slow signal | Files |
| --- | ---: |
| Network/live API indicators | 487 |
| Local inference/native/voice/FFI indicators | 367 |
| Composite slow risk, 3 or more signals | 231 |
| Benchmark/performance path | 199 |
| DB/container indicators | 194 |
| E2E/spec path | 152 |
| Live/real path | 143 |
| Integration path | 111 |
| Explicit timeout/sleep/wait signal | 90 |
| Child process/shell signal | 53 |
| Playwright import/spec signal | 40 |

Highest-risk slow files to lane explicitly:

| File | Why |
| --- | --- |
| `cloud/packages/tests/integration/model-catalog-live-server.live.e2e.test.ts` | live e2e, integration, timeout, DB/container, network, native/local signal. |
| `packages/app-core/test/app/onboarding-companion.live.e2e.test.ts` | live e2e, Playwright, timeout, child process, network, native/local signal. |
| `packages/app-core/test/app/memory-relationships.real.e2e.test.ts` | real e2e, timeout, child process, network, native/local signal. |
| `packages/app-core/test/app/qa-checklist.real.e2e.test.ts` | real e2e, timeout, child process, network, native/local signal. |
| `packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts` | live e2e, timeout, DB/container, network, native/local signal. |
| `packages/app-core/test/live-agent/agent-runtime.live.e2e.test.ts` | live e2e, timeout, DB/container, network, native/local signal. |
| `packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts` | live e2e, timeout, child process, network, native/local signal. |
| `plugins/app-lifeops/test/selfcontrol-desktop.live.e2e.test.ts` | live e2e, desktop/child process, timeout, network, native/local signal. |
| `packages/app/test/electrobun-packaged/electrobun-relaunch.e2e.spec.ts` | Playwright packaged desktop, timeout, child process, native/local signal. |
| `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts` | Playwright, timeout, network, native/local signal. |
| `plugins/app-task-coordinator/test/coding-agent-codex-artifact.live.e2e.test.ts` | live e2e, timeout, child process, DB/container. |
| `plugins/plugin-computeruse/src/__tests__/runtime.live.e2e.test.ts` | live e2e, timeout, child process, network. |
| `plugins/plugin-sql/src/__tests__/integration/agent.real.test.ts` | real integration, DB/container, network, native/local signal. |
| `cloud/packages/tests/runtime/integration/runtime-factory/config-change-race.test.ts` | integration, timeout, DB/container, network. |

Slow-test lane policy:

- PR required fast lane: unit/default tests and deterministic integration tests with no real external service dependency.
- PR optional e2e lane: deterministic browser/app smoke, sharded and capped by runtime budget.
- Post-merge live lane: real provider, connector, cloud, wallet, and destructive e2e tests.
- Scheduled/manual benchmark lane: `packages/benchmarks/**`, performance assertions, local-inference benchmarks, lifeops benches.
- Desktop/platform lane: Electrobun packaged, macOS/Windows/Linux specific, ComputerUse/browser-headful tests.
- Local-inference/native lane: GGUF, llama, voice, FFI, dflash, platform binary and model-artifact tests.

## Candidate Category 4 - Broken But Useful Tests

Definition: skipped, todo, excluded, platform-gated, secret-gated, or fixture-gated tests that still describe valuable product behavior.

Skip/todo inventory:

| Signal | Files | Lines |
| --- | ---: | ---: |
| Direct skip | 15 | 26 |
| Direct todo | 2 | 2 |
| `skipIf` | 57 | 100 |
| Conditional skip alias | 19 | 29 |
| Direct only | 0 | 0 |

Important broken-but-useful candidates:

| File | Signal | Recommended action |
| --- | --- | --- |
| `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts:211` | skipped parallel tick race test. | Keep; fix deterministic locking/clock fixture, then enable. This protects the single `ScheduledTask` runner architecture. |
| `packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx` | three skipped UI startup/provisioning cases plus heavy mocks. | Convert to deterministic runtime-gate harness; keep core cases. |
| `cloud/apps/api/test/e2e/group-k-affiliate.test.ts` | all three affiliate tests skipped. | Owner decision: restore auth/affiliate fixture or delete obsolete affiliate route coverage. |
| `plugins/plugin-sql/src/__tests__/migration/comprehensive-migration.real.test.ts:157` | skipped schema introspection suite. | Keep if migration introspection remains supported; move to DB lane and enable. |
| `packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts` | multiple skipped packaged desktop regressions. | Keep in desktop-packaged lane with platform-specific fixture requirements. |
| `packages/app/test/electrobun-packaged/electrobun-windows-startup.e2e.spec.ts` | Windows launcher gate. | Keep in Windows desktop lane; not PR default. |
| `packages/app/test/ui-smoke/cloud-wallet-import.spec.ts` | skipped cloud wallet import flows. | Keep if product path exists; convert to cloud e2e or remove if replaced. |
| `packages/app-core/src/services/local-inference/voice/ffi-bindings.test.ts` | skipped when stub dylib or bun missing. | Keep in native/voice lane; document artifact build prerequisite. |
| `plugins/plugin-nvidiacloud/__tests__/trajectory.test.ts` | skipped live provider test. | Convert to standard required-env helper or delete if provider unsupported. |
| `plugins/plugin-elizacloud/__tests__/text-native-plumbing.test.ts` | skipped live marker when env missing. | Keep only if it has live-lane coverage; otherwise convert to shape + live split. |
| `plugins/plugin-google-genai/__tests__/trajectory.test.ts` | skipped live marker when env missing. | Same as above. |
| `plugins/plugin-groq/__tests__/model-usage.test.ts` | skipped live marker when env missing. | Same as above. |
| `plugins/plugin-xai/__tests__/plugin.live.test.ts` | skipped live marker when env missing. | Same as above. |
| `plugins/app-lifeops/test/signature-deadline.e2e.test.ts` | todo. | Convert to scenario/fixture or owner-tagged issue. |
| `plugins/app-lifeops/test/portal-upload.e2e.test.ts` | todo. | Convert to scenario/fixture or owner-tagged issue. |

Existing config exclusions that should be treated as broken/useful until proven obsolete:

- `test/vitest/e2e.config.ts` excludes 6 heavy e2e paths, 2 checkout-dependent e2e paths, 18 specialized live e2e paths, and 8 credential-dependent e2e paths from the baseline e2e lane.
- `test/vitest/real.config.ts` has CI real-lane exclusions for headless ComputerUse, app-core live onboarding, benchmark app eval, plugin-form live structured-output integration, LifeOps live extraction/chat, media provider, life param extraction, wallet EVM live, plugin-shell real, and plugin-openrouter live models.
- `packages/app-core/vitest.config.ts` excludes app real/live e2e and local-inference engine e2e unless `ELIZA_INCLUDE_LIVE_E2E=1`.

Policy for skipped tests:

- Every direct skip must become one of: enabled, moved to explicit platform/live lane, replaced by `skipIf` with documented env, converted to issue-linked todo, or deleted.
- `skipIf` is acceptable only when the condition is a real lane boundary such as platform, env key, local artifact, live service, or destructive flag.
- Direct skip with no owner and no condition should fail cleanup review.
- Todo tests should not remain in required suites; either implement, move to docs/issue inventory, or delete.

## Candidate Category 5 - Lane Coverage

`node scripts/lint-lane-coverage.mjs` current output:

- 112 plugin directories scanned.
- 36 plugin directories without base unit/e2e coverage.
- 0 real-e2e required-env documentation gaps.
- Warn-only today; script says it should become failing after Phase 4.

Plugin directories without base coverage:

`app-2004scape`, `app-babylon`, `app-clawville`, `app-defense-of-the-agents`, `app-elizamaker`, `app-hyperscape`, `app-phone`, `app-polymarket`, `app-scape`, `app-screenshare`, `app-shopify`, `app-vincent`, `app-wallet`, `app-wifi`, `dist`, `plugin-action-bench`, `plugin-aosp-local-inference`, `plugin-capacitor-bridge`, `plugin-cli`, `plugin-discord-local`, `plugin-elevenlabs`, `plugin-eliza-classic`, `plugin-google-meet-cute`, `plugin-inmemorydb`, `plugin-local-inference`, `plugin-local-storage`, `plugin-localdb`, `plugin-pdf`, `plugin-social-alpha`, `plugin-streaming`, `plugin-suno`, `plugin-tee`, `plugin-vertex`, `plugin-web-search`, `plugin-x402`, `plugin-xmtp`.

Dry-run disposition:

- `plugins/dist` should not be treated as a plugin. Fix the coverage scanner or repo layout in a later implementation wave before making the warning fatal.
- Apps/plugins with real-only coverage, such as `app-shopify` and `app-vincent`, need at least one deterministic base smoke test or an explicit exemption.
- Plugins with `test` scripts but no local tests should either remove the no-op script, add minimal coverage, or mark manual/unsupported status in a registry.
- Plugins with files but no package-local test script may be covered by parent runners, but should be made explicit to avoid accidental orphaning.

Minimum lane model:

| Lane | Purpose | Required on PR | Examples |
| --- | --- | --- | --- |
| Unit/default | Fast deterministic source behavior. | Yes | `bun run test:ci`, package `test`. |
| Mock-free contract | Routes, connectors, scheduled tasks, registries, dispatch results. | Yes after conversion | `bun run test:lint:no-vi-mocks` once threshold is manageable. |
| Integration | PGlite/local DB/local services, no external secrets. | Yes or sharded optional depending runtime. | `test/vitest/integration.config.ts`, `cloud test:integration`. |
| E2E deterministic | App/browser flows using local harnesses. | Optional/required by changed path. | `bun run test:e2e`, package Playwright specs. |
| Real/live | External APIs, provider keys, cloud, wallet, destructive flows. | No, post-merge/scheduled/manual. | `bun run test:ci:live`, `bun run test:e2e:live`. |
| Platform/desktop/native | Electrobun, OS-specific, local-inference, voice, FFI. | Split by platform workflow. | desktop contract, local-inference matrix. |
| Benchmark/performance | Runtime/quality/perf signal, not correctness gate. | No. | benchmark workflows, LifeOps benches. |

## Candidate Category 6 - Test Validation

Inventory and lint commands:

```sh
rg --files | rg '(^|/)(test|tests|__tests__|__test-helpers__|__mocks__)(/|$)|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|_(test|spec)\.py$'
node scripts/lint-lane-coverage.mjs
node scripts/lint-no-vi-mocks.mjs
bun run test:lint
```

Expected current status:

- `node scripts/lint-lane-coverage.mjs` exits 0 but warns about missing base plugin coverage.
- `node scripts/lint-no-vi-mocks.mjs` is expected to fail until mocked-test conversion is complete.
- `bun run test:lint` is expected to fail for the same mock reason until the no-mock gate is phased in.

Core validation commands:

```sh
bun run format:check
bun run lint:check
bun run typecheck
bun run test:ci
TEST_SHARD=1/3 bun run test:ci
TEST_SHARD=2/3 bun run test:ci
TEST_SHARD=3/3 bun run test:ci
```

Focused validation commands:

```sh
TEST_PACKAGE_FILTER='\\((packages/core|packages/app-core|packages/ui)\\)' TEST_SCRIPT_FILTER='^test$' node scripts/run-all-tests.mjs --no-cloud
TEST_PACKAGE_FILTER='\\((plugins/app-lifeops|plugins/plugin-health)\\)' TEST_SCRIPT_FILTER='^test$' node scripts/run-all-tests.mjs --no-cloud
bun run --cwd plugins/app-lifeops lint:default-packs
bun run --cwd plugins/app-lifeops test
bun run --cwd packages/core test
bun run --cwd packages/app-core test
bun run --cwd packages/ui test
```

E2E/live validation commands:

```sh
bun run test:e2e
TEST_LANE=post-merge bun run test:e2e:live
TEST_LANE=post-merge bun run test:ci:live
ELIZA_INCLUDE_LIVE_E2E=1 bun run --cwd packages/app-core test
```

Cloud validation commands:

```sh
bun run --cwd cloud verify
bun run --cwd cloud test:repo-unit
bun run --cwd cloud test:integration
bun run --cwd cloud test:properties
bun run --cwd cloud test:runtime
bun run --cwd cloud test:e2e:bundle
bun run --cwd cloud test:playwright
```

Cleanup-specific validation:

```sh
node scripts/run-all-tests.mjs --no-cloud --only=test
node scripts/run-all-tests.mjs --no-cloud --only=e2e
TEST_LANE=post-merge node scripts/run-all-tests.mjs --no-cloud --only=e2e
git diff -- docs/audits/repo-cleanup-2026-05-11/wave-05-test-cleanup.md
```

## CI Runtime Strategy

Recommended staged rollout:

1. Baseline: collect current runtimes per package script from `scripts/run-all-tests.mjs` output and CI job durations.
2. Quarantine: label broken-but-useful tests with lane, owner, prerequisite, and expiry. Do not keep unconditional skips in required lanes.
3. Convert: work from mock-heavy connector/runtime files first, replacing mock-only assertions with harness-backed behavior tests.
4. Split: move live/real/desktop/native/benchmark files to explicit commands and workflow jobs.
5. Enforce: turn `lint-lane-coverage` from warn-only to fail after false positives such as `plugins/dist` are fixed.
6. Tighten: introduce a thresholded no-mock gate, then ratchet down allowed violations by area.
7. Budget: cap PR required tests at a stable runtime target, shard by package, and keep slow/live lanes post-merge or scheduled.

Runtime budgets to aim for:

- Unit/default PR lane: under 15 minutes per shard.
- Plugin PR lane: under 30 minutes total or split into deterministic shards.
- Cloud PR lane: path-filtered, each job under 25 minutes.
- E2E PR lane: smoke-only, under 20 minutes per shard.
- Live/post-merge lane: under 60 minutes, non-blocking for external provider outages unless the provider is the product under test.
- Benchmark/manual lane: no PR blocking; publish artifacts and trend regressions.

## Risks

- Mock deletion before harness conversion can remove coverage for connector dispatch, route auth, and runtime orchestration.
- Slow tests moved out of PR without smoke replacements can hide app-startup, scheduler, desktop, and cloud regressions.
- Current counts include local dirty/untracked files; cleanup decisions must be repeated on the target branch.
- `plugins/dist` appears in plugin coverage scanning and will create false failures if lane coverage becomes fatal too early.
- Many live tests skip cleanly when secrets are missing; a green CI run may not mean live behavior was exercised.
- Platform-specific tests can become permanently invisible if they are only gated by local `skipIf` and not wired to matching OS workflows.
- LifeOps tests that assert text prompts instead of structural `ScheduledTask` behavior can pass while the runner contract regresses.
- Benchmarks and QA capture specs may write artifacts; they should be kept out of required correctness lanes unless assertions are explicit.

## Implementation Checklist

- [ ] Re-run inventory on a clean branch and store counts in the cleanup PR description.
- [ ] Fix lane coverage false positives, especially `plugins/dist`.
- [ ] For every direct skip, decide: enable, lane-gate, issue-link, or delete.
- [ ] Replace trivial assertions with concrete invariants or delete the affected test block.
- [ ] Split artifact capture tests from correctness tests, especially `packages/app/test/ui-smoke/ai-qa-capture.spec.ts`.
- [ ] Triage the top 25 mock-heavy files and classify each as keep, convert, or delete.
- [ ] Convert connector/channel/route tests to typed `DispatchResult`, mockoon/local HTTP, PGlite, or harness-backed tests where feasible.
- [ ] Verify LifeOps and plugin-health tests respect the architecture: one `ScheduledTask` primitive, structural behavior, health via registries.
- [ ] Add or document base tests for plugin directories currently reported as missing coverage.
- [ ] Move local-inference, FFI, voice, desktop, and packaged app tests to explicit platform/native lanes.
- [ ] Move benchmark/performance tests to scheduled/manual lanes with artifact reporting.
- [ ] Shard `test:ci` and e2e lanes by package using `TEST_SHARD=N/M`.
- [ ] Run focused package validation after each cleanup batch.
- [ ] Run full `bun run test:ci`, cloud path tests, and post-merge live lane before final approval.
- [ ] Turn warn-only lint gates fatal only after false positives and accepted exemptions are documented.

## Non-Destructive Notes

This dry run does not propose immediate file deletions. Every delete/convert action above requires a separate implementation PR with focused diffs, owner review for affected package/plugin areas, and validation output attached.
