# Issue #13432 Resumable Upload State Evidence

## Change

- Added `packages/import-conversations/src/core/resumable.ts`.
- The module models resumable import upload sessions as deterministic state:
  - positive upload/chunk sizing,
  - safe session ids,
  - expected byte ranges per chunk,
  - SHA-256 validation,
  - idempotent duplicate chunk retries,
  - missing-range reporting,
  - progress and completion state.

## Local verification

- `bun run --cwd packages/import-conversations test -- src/core/resumable.test.ts`
- `bun run --cwd packages/import-conversations test` (14 files, 161 tests)
- `bun run --cwd packages/import-conversations typecheck`
- `bun run --cwd packages/import-conversations build`
- `bunx @biomejs/biome check packages/import-conversations/src/core/resumable.ts packages/import-conversations/src/core/resumable.test.ts packages/import-conversations/src/core/index.ts .github/issue-evidence/13432-resumable-upload-state.md --no-errors-on-unmatched`
- `git diff --check`

## Evidence matrix

- Backend logs: N/A - pure importer-core state primitive; no route or object-store write path changed.
- Frontend screenshots/video: N/A - no UI changed.
- Real-LLM trajectories: N/A - no agent/action/provider/prompt/model behavior changed.
- Domain artifacts: unit tests prove chunk range/hash rejection, duplicate retry idempotency, missing-range reporting, and complete progress state.
