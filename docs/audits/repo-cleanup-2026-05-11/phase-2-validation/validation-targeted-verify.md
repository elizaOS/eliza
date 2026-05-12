# Phase 2 validation - targeted verify worker D

Date: 2026-05-11
Worker: D
Workspace: `/Users/shawwalters/eliza-workspace/eliza/eliza`
Bun: `/Users/shawwalters/.bun/bin/bun` version `1.3.13`

## Summary

Overall result: FAIL.

Requested targeted checks were run, plus the relevant discovered package-level verify scripts that were safe and applicable to the cleanup areas. The main blockers are stale launch-QA required file references, cloud Biome formatting failures, and an environment/toolchain failure loading `sharp` under LifeOps tests on macOS arm64.

## Commands

| Command | Exit | Result | Notes |
| --- | ---: | --- | --- |
| `/Users/shawwalters/.bun/bin/bun run test:launch-qa` | 1 | FAIL | Fails in `scripts/launch-qa/run.test.ts` before docs/mobile/model/dry-run stages. |
| `/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify` | 1 | FAIL | Default-pack lint and type build pass; Vitest fails from `sharp` native module load error. |
| `/Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend verify` | 1 | FAIL | Stops at Biome lint/format check. Typecheck/build did not run. |
| `/Users/shawwalters/.bun/bin/bun run --cwd cloud verify` | 1 | FAIL | Stops at `lint:check` with 13 formatting errors. Circular dependency and typecheck stages did not run. |
| `/Users/shawwalters/.bun/bin/bun run --cwd packages/inference verify:contract` | 0 | PASS | `[kernel-contract] OK kernels=6 targets=21 manifestNames=6`. |
| `/Users/shawwalters/.bun/bin/bun run --cwd packages/inference verify:reference` | 0 | PASS | Reference self-test passes; all reported scores finite. |
| `/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify:live-schedule` | 1 | ENV FAIL | Local API at `127.0.0.1:31337` was not running. |

## Failures

### `test:launch-qa`

The Bun test phase fails `launch QA task selection > quick suite task file references exist`.

Missing required files:

- `packages/app-core/src/api/client-cloud-direct-auth.test.ts`
- `packages/app-core/src/state/persistence-cloud-active-server.test.ts`
- `packages/agent/src/actions/search.test.ts`
- `packages/agent/src/runtime/operations/vault-integration.test.ts`

Likely owners: launch QA config owners, plus app-core and agent package owners if those tests were moved or intentionally removed.

Next action: update `scripts/launch-qa/run.mjs` required file paths/tasks to match the current tree, or restore the missing focused tests if they were removed unintentionally, then rerun `/Users/shawwalters/.bun/bin/bun run test:launch-qa`.

### `plugins/app-lifeops verify`

Passing stages:

- `lint:default-packs`: clean, 0 findings.
- `build:types`: completed.

Failing stage: `vitest run --config vitest.config.ts`.

Final counts:

- Test files: 5 failed, 51 passed.
- Tests: 11 failed, 525 passed, 1 skipped.

Common failure:

`sharp` cannot load `@img/sharp-darwin-arm64` because macOS rejects the native module code signature:

`code signature ... not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs`

Failed suites/tests include:

- `plugins/app-lifeops/src/plugin.test.ts`
- `plugins/app-lifeops/test/action-structure-audit.test.ts`
- `plugins/app-lifeops/test/payments-action.test.ts`
- `plugins/app-lifeops/test/scheduled-task-action.test.ts`
- `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts`

Non-fatal warnings also appeared for package export condition ordering (`types` after `default`) and missing dependency sourcemaps.

Likely owners: LifeOps owners for test coverage, with dependency/tooling owner support for the local `sharp` native install/codesign issue.

Next action: repair or reinstall the macOS arm64 `sharp` optional dependency in the shared workspace, then rerun `/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify`.

### `cloud/apps/frontend verify`

Fails immediately in `biome check .`.

Formatting failure:

- `cloud/apps/frontend/src/pages/payment/[paymentRequestId]/page.tsx`

Biome wants `PaymentRequestStatus` collapsed from a multiline string union into one line.

Likely owner: cloud frontend/payment cleanup owner.

Next action: format the frontend file, then rerun `/Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend verify` so typecheck and build can execute.

### `cloud verify`

Fails immediately in `biome check .`.

Biome reported schema info:

- `cloud/biome.json` schema points at `2.4.14`; CLI is `2.4.15`.

Formatting failures:

- `cloud/apps/api/auth/logout/route.ts`
- `cloud/apps/api/auth/steward-session/route.ts`
- `cloud/apps/api/v1/apis/tunnels/tailscale/auth-key/route.ts`
- `cloud/apps/frontend/src/pages/payment/[paymentRequestId]/page.tsx`
- `cloud/packages/db/schemas/voice-imprints.ts`
- `cloud/packages/lib/auth/cookie-domain.ts`
- `cloud/packages/lib/services/content-safety.ts`
- `cloud/packages/lib/services/oauth-callback-bus.ts`
- `cloud/packages/lib/services/sensitive-callback-bus.ts`
- `cloud/packages/tests/unit/cookie-domain.test.ts`
- `cloud/packages/tests/unit/oauth-callback-bus.test.ts`
- `cloud/packages/tests/unit/payment-callback-bus.test.ts`
- `cloud/packages/tests/unit/sensitive-callback-bus.test.ts`

Likely owners: cloud API/lib/db/test cleanup owners, plus cloud frontend owner for the payment page.

Next action: coordinate with current cloud-file owners, apply Biome formatting, then rerun `/Users/shawwalters/.bun/bin/bun run --cwd cloud verify`.

### `plugins/app-lifeops verify:live-schedule`

Fails because the live local API is unavailable:

- URL: `http://127.0.0.1:31337/api/lifeops/schedule/merged-state?scope=local&refresh=1&timezone=America%2FLos_Angeles`
- Error: `ConnectionRefused`

Likely owner: LifeOps runtime/local app operator, not necessarily a code owner.

Next action: start the expected local LifeOps API on port `31337`, or rerun with `--api-base` pointed at an active environment.

## Discovered Verify Scripts

Run:

- `cloud/package.json` `verify`, because cloud files are active cleanup targets and this is the package-level verify behind root `verify:cloud`.
- `packages/inference/package.json` `verify:contract` and `verify:reference`, because they are non-hardware targeted checks and inference verify files are active cleanup targets.
- `plugins/app-lifeops/package.json` `verify:live-schedule`, because it is a LifeOps verify script; result is environment-gated.

Not run:

- `packages/inference` `verify:metal` and `verify:vulkan`: hardware/GPU SDK checks, better suited to a dedicated hardware verification lane.
- `packages/native-plugins/gateway` `verify`: runs iOS pod install/xcodebuild and Android Gradle clean/build/test; no current gateway cleanup target was identified, and this is toolchain-heavy.
- `packages/elizaos/templates/project` `verify`: template placeholder package, not relevant to the cleanup targets.

## Side Effects

- No source/config/test files were intentionally edited by this worker.
- This report was created at `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-targeted-verify.md`.
- `plugins/app-lifeops verify` ran `build:types`, which updated/generated ignored declaration artifacts under `plugins/app-lifeops/dist/**/*.d.ts` and `*.d.ts.map`. `plugins/app-lifeops/dist` is ignored by `.gitignore` and has no tracked files.
- `cloud/apps/frontend verify` and `cloud verify` stopped in Biome check mode and did not apply writes.
- `packages/inference verify:reference` ran `./gen_fixture --self-test`; it did not regenerate tracked fixture JSON.
- Existing unrelated dirty worktree entries were present before this validation run and were not reverted.
