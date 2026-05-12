# Blocker: root app-core test hang

Date: 2026-05-12

## Reproduction

- Timeboxed root app-core path:
  `TEST_PACKAGE_FILTER='packages/app-core' TEST_SCRIPT_FILTER='^test$' bun run test --no-cloud`
- Before the fix, app-core's default Vitest run collected
  `packages/app-core/platforms/electrobun/src/*.test.ts` files and stalled or
  exited after listing zero tests for several Electrobun files.
- A focused Electrobun package reproduction also failed under the root runner:
  `TEST_PACKAGE_FILTER='packages/app-core/platforms/electrobun' TEST_SCRIPT_FILTER='^test$' bun run test --no-cloud`
  imported `bun:test` files through Vitest and failed with
  `Cannot find package 'bun:test'`.

## Findings

- `packages/app-core/vitest.config.ts` excluded `*.live*`, `*.real*`, and
  `*.e2e*` patterns, but still recursed into `platforms/electrobun/**`.
- Several Electrobun tests are Bun-test harness files, not app-core Vitest unit
  tests. They must not be collected by the app-core unit config.
- `scripts/run-all-tests.mjs` forced `ELIZA_LIVE_TEST=1` into every child
  process. That made ordinary package `test` scripts capable of running live
  provider suites whenever credentials were present.
- `test/helpers/__tests__/live-agent-test.smoke.test.ts` is a live provider
  smoke file with a plain `.smoke.test.ts` suffix, so the existing live/e2e
  excludes did not catch it.

## Changes

- `packages/app-core/vitest.config.ts`
  - Excludes `platforms/electrobun/**` from default app-core unit runs.
  - Excludes `test/helpers/__tests__/live-agent-test.smoke.test.ts` from
    default app-core unit runs.
- `scripts/run-all-tests.mjs`
  - Defaults `ELIZA_LIVE_TEST` to `0` for ordinary package `test` scripts.
  - Preserves explicit `ELIZA_LIVE_TEST`, enables live behavior for
    `TEST_LANE=post-merge`, and enables it for `*:live` scripts.
  - Skips `packages/app-core/platforms/electrobun#test` by default with an
    explicit opt-in: `ELIZA_INCLUDE_ELECTROBUN_TESTS=1`.

## Validation

- `node --check scripts/run-all-tests.mjs` passed.
- Root runner Electrobun package gate:
  `TEST_PACKAGE_FILTER='packages/app-core/platforms/electrobun' TEST_SCRIPT_FILTER='^test$' bun run test --no-cloud`
  now skips with the opt-in message.
- App-core excluded-file check:
  `vitest run --config vitest.config.ts platforms/electrobun/src/rpc-port-resolver.test.ts test/helpers/__tests__/live-agent-test.smoke.test.ts --passWithNoTests`
  found no test files and printed the expected exclude list.
- Focused app-core unit check:
  `vitest run --config vitest.config.ts test/helpers/live-provider.test.ts src/api/dev-route-catalog.test.ts`
  passed: 2 files, 16 tests.
- Static app-core test collection:
  `vitest list --config vitest.config.ts --filesOnly --staticParse --json`
  returned 86 files with zero `platforms/electrobun` and zero
  `live-agent-test.smoke` matches.
