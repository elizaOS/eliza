# Workflow and app-core suppression fix

Date: 2026-05-12

## Scope

- `plugins/plugin-workflow/src/utils/clarification.ts`
- `plugins/plugin-workflow/src/lib/workflow-clarification.ts`
- `plugins/plugin-workflow/__tests__/unit/clarification.test.ts`
- `plugins/plugin-workflow/__tests__/unit/workflow-clarification.test.ts`
- `packages/app-core/test/benchmarks/action-selection-runner.ts`
- `packages/app-core/test/benchmarks/action-selection.real.test.ts`
- `packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts`
- `scripts/write-build-info.ts`
- `scripts/lib/repo-root.d.mts`

## Changes

- Removed the workflow runtime-guard `@ts-expect-error` comments by widening
  guard entrypoints to accept `unknown` payload arrays and narrowing with
  local record guards.
- Tightened clarification normalization so malformed legacy payloads still
  normalize through runtime checks without weakening the public
  `ClarificationRequest` output.
- Replaced app-core benchmark unresolved dynamic-import suppressions with URL
  based runtime imports and explicit string package specifiers.
- Replaced the Telegram live-test cleanup suppression with a narrow
  `RuntimeWithOptionalCleanup` boundary type.
- Added `scripts/lib/repo-root.d.mts` so the `.mjs` helper imported from
  `scripts/write-build-info.ts` has a NodeNext-compatible declaration file
  without a call-site suppression.
- Removed untracked `.DS_Store` files found under `plugins/plugin-workflow`.

## Validation

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-workflow typecheck`
  passed.
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-workflow test:unit`
  passed: 21 files, 271 tests.
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-workflow lint:check`
  passed.
- `node --import tsx scripts/write-build-info.ts` passed.
- `git diff --check` on the touched suppression-removal files passed.

## Notes

- A direct ad hoc `tsc --ignoreConfig` over app-core benchmark/live test files
  is not a useful validator because it bypasses the package tsconfig paths and
  pulls unrelated workspace source with missing Bun/path aliases. The changed
  benchmark/live files are outside `packages/app-core/tsconfig.json`'s default
  include set.
