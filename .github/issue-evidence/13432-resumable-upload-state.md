# Issue #13432 Resumable Upload State Evidence

## Change

- Added `packages/import-conversations/src/core/resumable.ts`.
- The module models resumable import upload sessions as deterministic state:
  - positive upload/chunk sizing,
  - safe session ids,
  - expected byte ranges per chunk,
  - SHA-256 validation,
  - idempotent duplicate chunk retries,
  - hydration validation for persisted session metadata,
  - merge semantics for independently accepted non-overlapping chunks from concurrent stale reads,
  - missing-range reporting,
  - progress and completion state.
- The state stores chunk metadata and digests only. It does not store bytes or introduce a second file/media store.

## Local verification

- `bun run --cwd packages/import-conversations test -- src/core/resumable.test.ts`
- `bun run --cwd packages/import-conversations test` (14 files, 161 tests)
- `bun run --cwd packages/import-conversations typecheck`
- `bun run --cwd packages/import-conversations build`
- `bunx @biomejs/biome check packages/import-conversations/src/core/resumable.ts packages/import-conversations/src/core/resumable.test.ts packages/import-conversations/src/core/index.ts .github/issue-evidence/13432-resumable-upload-state.md --no-errors-on-unmatched`
- `git diff --check`

Follow-up validation for the concurrency/hydration review fixes:

- `node /Users/shawwalters/milaidy/eliza/node_modules/vitest/vitest.mjs run --config /tmp/codex-vitest-empty.mjs packages/import-conversations/src/core/resumable.test.ts --run` - pass, 1 file / 11 tests.
- `bunx tsc --ignoreConfig --noEmit --skipLibCheck --typeRoots /Users/shawwalters/milaidy/eliza/node_modules/@types --types node --lib ES2022 --module ESNext --target ES2022 --moduleResolution bundler packages/import-conversations/src/core/resumable.ts` - pass.
- `bunx @biomejs/biome check packages/import-conversations/src/core/resumable.ts packages/import-conversations/src/core/resumable.test.ts packages/import-conversations/src/core/index.ts .github/issue-evidence/13432-resumable-upload-state.md --no-errors-on-unmatched && git diff --check` - pass.

The package script `bun run --cwd packages/import-conversations test -- src/core/resumable.test.ts` could not start in the sparse verification worktree until workspace dependencies are installed (`node_modules/vitest/vitest.mjs` missing). The focused Vitest invocation above uses the installed repo Vitest binary and a minimal node-environment config to exercise the same test file.

## Evidence matrix

- Backend logs: N/A - pure importer-core state primitive; no route or object-store write path changed.
- Frontend screenshots/video: N/A - no UI changed.
- Real-LLM trajectories: N/A - no agent/action/provider/prompt/model behavior changed.
- Domain artifacts: unit tests prove chunk range/hash rejection, duplicate retry idempotency, persisted-state validation, concurrent non-overlapping chunk merge, conflict rejection, missing-range reporting, and complete progress state.
