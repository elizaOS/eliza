# Phase 2 Deep Dive - LifeOps Launch QA, Sharp, Live Schedule

Date: 2026-05-11
Worker: Phase 2 deep-dive worker 4
Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`

## Scope

This report triages three validation blockers from the targeted verify pass:

- root `test:launch-qa` failing on stale/missing launch-QA references,
- `plugins/app-lifeops verify` failing under macOS arm64 because `sharp` cannot load in the Vitest process,
- `plugins/app-lifeops verify:live-schedule` requiring a live local API at `127.0.0.1:31337`.

No source/config/test files were edited for this deep dive.

## Executive Summary

`test:launch-qa` is not just one stale self-test. The first failure is stale `scripts/launch-qa/run.mjs` task paths, but the later stages currently expose additional launch gate drift:

- launchdocs command checker now fails on documented `bun run build:web` and `bun run desktop:stack-status` references,
- mobile artifact checker fails the iOS app-group entitlement expectation,
- model-data checker fails because most `plugins/app-training/datasets/*.jsonl` files use the current `eliza_native_v1` boundary format while `check-model-data.mjs` only validates top-level `row.messages`.

The LifeOps `sharp` failure is environment-specific but reproducible: Codex's bundled Node is signed with hardened runtime under Team ID `2DC432GLL2`; Vitest uses `#!/usr/bin/env node`, so inside Codex it runs under that Node and macOS library validation rejects the ad-hoc signed `sharp-darwin-arm64.node`. The same selected LifeOps suites pass when `PATH=/opt/homebrew/bin:$PATH` makes Vitest use Homebrew Node. A repo-level code hardening fix is still worthwhile: LifeOps imports `sharp` eagerly from `src/lifeops/screen-context.ts`, so unrelated tests and startup paths pay the native-module load cost.

`verify:live-schedule` is correctly classified as an environment gate. It needs a running local app/API with LifeOps routes and database table routes, plus real schedule/activity data; without that, it fails at connection setup.

## Launch-QA Findings

### Immediate `test:launch-qa` Failure

Command run:

```bash
/Users/shawwalters/.bun/bin/bun test scripts/launch-qa/*.test.ts
```

Result: FAIL. `scripts/launch-qa/run.test.ts` fails `quick suite task file references exist`.

Stale required file references in `scripts/launch-qa/run.mjs`:

| Task | Stale reference | Current state |
| --- | --- | --- |
| `app-core-focused` | `packages/app-core/src/api/client-cloud-direct-auth.test.ts` | Moved to `packages/ui/src/api/client-cloud-direct-auth.test.ts`. |
| `app-core-focused` | `packages/app-core/src/state/persistence-cloud-active-server.test.ts` | Moved to `packages/ui/src/state/persistence-cloud-active-server.test.ts`. |
| `app-core-focused` | `packages/app-core/scripts/startup-integration-script-drift.test.ts` | Still exists in app-core. |
| `agent-focused` | `packages/agent/src/actions/search.test.ts` | No current file found. Agent search coverage appears to have changed shape; do not blindly recreate this path. |
| `agent-focused` | `packages/agent/src/runtime/operations/vault-integration.test.ts` | Moved to `packages/agent/test/runtime/operations/vault-integration.test.ts`. |

`node scripts/launch-qa/run.mjs --suite quick --dry-run --json` reports `app-core-focused` and `agent-focused` as unavailable. `lifeops-focused`, `training-focused`, `mobile-artifacts`, `model-data`, and `cloud-api-key-client` are available.

Safest fix shape:

1. Split the moved UI tests out of `app-core-focused` or retarget the task to `packages/ui/vitest.config.ts`.
2. Keep `packages/app-core/scripts/startup-integration-script-drift.test.ts` in an app-core task.
3. Retarget vault coverage to `packages/agent/test/runtime/operations/vault-integration.test.ts`.
4. Ask the agent owner whether `packages/agent/src/actions/search.test.ts` should be replaced by current web-search/tool-cache/database/contact coverage or dropped from the launch quick gate.
5. Improve `taskExists()` reporting so missing `requiredFiles` are named; today it returns the generic "optional script missing" reason for any unavailable task.

### Downstream Launch-QA Failures

After the self-test blocker, current static stages also fail when run directly:

```bash
node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json
node scripts/launch-qa/check-mobile-artifacts.mjs --json --allow-missing-generated
node scripts/launch-qa/check-model-data.mjs --json
```

Observed results:

- `check-docs`: 5 missing-script errors.
  - `packages/docs/docs/launchdocs/14-lifeops-qa.md` references `bun run build:web`.
  - `packages/docs/docs/launchdocs/15-utility-apps-qa.md` references `bun run build:web`.
  - `packages/docs/docs/launchdocs/23-ai-qa-master-plan.md` references `bun run desktop:stack-status` and `bun run build:web`.
  - `packages/docs/docs/launchdocs/25-ai-qa-results-2026-05-11.md` references `bun run build:web`.
- `check-mobile-artifacts`: expected iOS app group `group.app.eliza` from `packages/app/app.config.ts` `appId: "app.eliza"`, but `packages/app-core/platforms/ios/App/App/App.entitlements` contains `group.ai.elizaos.app`.
- `check-model-data`: 272 schema errors across 8 of 9 JSONL files. The checker expects top-level `messages`, but current datasets mostly use `format: "eliza_native_v1"` with `request.messages` and `response.text`.

Additional launch-QA drift:

- `.github/workflows/launch-qa.yml` watches `launchdocs/**`, but the checked docs are under `packages/docs/docs/launchdocs/**`.
- `scripts/launch-qa/check-docs.mjs --scope=launchdocs` scans `packages/docs/docs/launchdocs`, `packages/docs/launchdocs`, and `launchdocs`; it does not scan `docs/launchdocs`.
- `docs/launchdocs/14-lifeops-qa.md` still exists and differs from `packages/docs/docs/launchdocs/14-lifeops-qa.md`; LifeOps README files point at `docs/launchdocs/14-lifeops-qa.md`.

Safest fix shape:

1. Decide the canonical launchdocs root. Prefer one checked root, then align README links, docs checker roots, and workflow path filters.
2. For `build:web`, either add a root alias if the docs intentionally describe a root command, or change docs to `bun run --cwd packages/app build:web` / existing root `build:client`.
3. For `desktop:stack-status`, either add a root alias to `node packages/app-core/scripts/desktop-stack-status.mjs`, or update docs to the direct node command.
4. Align the iOS app group with app identity, or teach `check-mobile-artifacts` the intended legacy group if `group.ai.elizaos.app` is deliberate.
5. Update `check-model-data.mjs` to validate `eliza_native_v1` rows, not just OpenAI-style `row.messages`, or narrow the scan to datasets that are meant to use that schema.

## LifeOps `sharp` Failure

Failing command:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test \
  src/plugin.test.ts \
  test/action-structure-audit.test.ts \
  test/payments-action.test.ts \
  test/scheduled-task-action.test.ts \
  src/lifeops/scheduled-task/scheduler.test.ts
```

Result under Codex app shell: FAIL.

Failed suites/tests match the targeted verify report:

- `plugins/app-lifeops/src/plugin.test.ts`
- `plugins/app-lifeops/test/action-structure-audit.test.ts`
- `plugins/app-lifeops/test/payments-action.test.ts`
- `plugins/app-lifeops/test/scheduled-task-action.test.ts`
- `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts`

Root cause evidence:

- `which node` inside Codex resolves to `/Applications/Codex.app/Contents/Resources/node`.
- That Node is Developer-ID signed by OpenAI and has hardened runtime enabled.
- `node_modules/.bin/vitest` uses `#!/usr/bin/env node`, so Vitest runs under that hardened Node.
- macOS rejects `node_modules/.bun/@img+sharp-darwin-arm64@0.34.5/.../sharp-darwin-arm64.node` with: `mapping process and mapped file (non-platform) have different Team IDs`.
- The same `sharp` package imports successfully under Bun and under Homebrew Node.
- The same selected LifeOps suites pass with:

```bash
PATH=/opt/homebrew/bin:$PATH /Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test \
  src/plugin.test.ts \
  test/action-structure-audit.test.ts \
  test/payments-action.test.ts \
  test/scheduled-task-action.test.ts \
  src/lifeops/scheduled-task/scheduler.test.ts
```

Passing result with Homebrew Node: 5 files passed, 21 tests passed, 1 skipped.

Code path:

- `plugins/app-lifeops/src/lifeops/screen-context.ts` imports `sharp` statically.
- `plugins/app-lifeops/src/lifeops/index.ts` exports screen context.
- Broad plugin/action imports pull that module into unrelated tests, causing native `sharp` to load before screen image analysis is actually needed.

Safest fix shape:

1. Validation environment: run LifeOps Vitest with a non-hardened Node first, e.g. `PATH=/opt/homebrew/bin:$PATH ...`, or ensure CI uses a Node binary that allows native addons.
2. Code hardening: convert the static `sharp` import in `screen-context.ts` to a lazy dynamic import inside `analyzeImage()`, ideally behind an injectable image analyzer adapter. That keeps payments/scheduler/plugin tests from loading native image code.
3. Dependency hygiene: keep `packages/app-core/scripts/patch-deps.mjs` sharp normalization, but do not rely on it as the only fix. The current blocker is process signing/library validation, not missing optional dependencies.

Risk:

- Environment-only fixes can make local validation pass while leaving LifeOps startup unnecessarily coupled to native image tooling.
- Lazy import changes are low behavioral risk if covered by `lifeops-screen-context` tests, but should be validated on a real frame to prove image analysis still works.

## Live Schedule Verification

Command run:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify:live-schedule --json
```

Result: ENV FAIL, `ConnectionRefused` at:

```text
http://127.0.0.1:31337/api/lifeops/schedule/merged-state?scope=local&refresh=1&timezone=America%2FLos_Angeles
```

Script requirements from `plugins/app-lifeops/scripts/verify-live-schedule-data.ts`:

- local API base, default `http://127.0.0.1:31337`, or `--api-base <url>`,
- timezone, default current system timezone, or `--timezone <IANA timezone>`,
- LifeOps schedule route `GET /api/lifeops/schedule/merged-state`,
- database table route `GET /api/database/tables/:table/rows`,
- populated tables:
  - `life_schedule_merged_states`,
  - `life_schedule_observations`,
  - `life_activity_events`,
  - `life_activity_signals`,
  - optional but warning-producing: `life_browser_sessions`, `life_screen_time_sessions`.

Safest validation shape:

```bash
bun run dev:desktop
curl -f http://127.0.0.1:31337/api/health
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify:live-schedule --json
```

If the API is on another port:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify:live-schedule --json --api-base http://127.0.0.1:<port>
```

Risk:

- This is not a CI-safe unit gate. It validates a live local dataset and local telemetry ingestion.
- A healthy server can still fail if the schedule/activity tables are empty or stale. Treat failures after connection as product/data coverage findings, not basic compile/test failures.

## Owners

| Area | Likely owner |
| --- | --- |
| `scripts/launch-qa/run.mjs`, launch-QA workflow, docs checker roots | Launch QA / release engineering owner |
| Moved cloud-auth and persistence tests | UI/app-core owners |
| Agent search/vault task coverage | Agent runtime/actions owner |
| LifeOps focused task and sharp eager import | LifeOps owner |
| `sharp` process signing/toolchain behavior in Codex/local validation | Tooling/dependency owner |
| iOS app-group entitlement mismatch | Mobile/app identity owner |
| `check-model-data` vs `eliza_native_v1` datasets | App-training/model-data owner |
| `verify:live-schedule` runtime and real data | LifeOps runtime/local app operator |

## Validation Commands

Use these after approved fixes:

```bash
/Users/shawwalters/.bun/bin/bun test scripts/launch-qa/*.test.ts
node scripts/launch-qa/run.mjs --suite quick --dry-run --json
node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json
node scripts/launch-qa/check-mobile-artifacts.mjs --json --allow-missing-generated
node scripts/launch-qa/check-model-data.mjs --json
/Users/shawwalters/.bun/bin/bun run test:launch-qa
```

For LifeOps under this Codex macOS environment:

```bash
PATH=/opt/homebrew/bin:$PATH /Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test \
  src/plugin.test.ts \
  test/action-structure-audit.test.ts \
  test/payments-action.test.ts \
  test/scheduled-task-action.test.ts \
  src/lifeops/scheduled-task/scheduler.test.ts
```

For full LifeOps verify after the `sharp` environment or lazy-import fix:

```bash
PATH=/opt/homebrew/bin:$PATH /Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
```

For live schedule:

```bash
bun run dev:desktop
curl -f http://127.0.0.1:31337/api/health
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify:live-schedule --json
```

## Blocker Summary

Do not proceed to cleanup signoff on the affected lanes until:

1. `test:launch-qa` task references are updated and the downstream docs/mobile/model-data launch gates are either fixed or explicitly split into owned follow-up blockers.
2. LifeOps verify is run under a Node/runtime that can load native addons, or LifeOps stops eagerly importing `sharp` in unrelated tests.
3. `verify:live-schedule` is marked as a live-data/manual gate with documented startup and data prerequisites, not treated as a default CI gate.
