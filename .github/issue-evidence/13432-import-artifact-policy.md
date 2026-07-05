# Issue #13432 Import Artifact Policy Evidence

## Change

- Added `packages/import-conversations/src/core/artifacts.ts`.
- The module builds deterministic content-addressed descriptors for import artifacts.
- Storage keys are scoped by tenant, app, and import batch before the SHA-256 object name.
- Raw uploads get short retention by default; longer raw retention requires an explicit reason.
- Derived artifacts are marked for batch-lifecycle deletion.

## Local verification

- `bun run --cwd packages/import-conversations test -- src/core/artifacts.test.ts`
- `bun run --cwd packages/import-conversations test` (14 files, 160 tests)
- `bun run --cwd packages/import-conversations typecheck`
- `bunx @biomejs/biome check packages/import-conversations/src/core/artifacts.ts packages/import-conversations/src/core/artifacts.test.ts packages/import-conversations/src/core/index.ts .github/issue-evidence/13432-import-artifact-policy.md --no-errors-on-unmatched`
- `git diff --check`

## Evidence matrix

- Backend logs: N/A - pure importer-core policy primitive; no route or object-store write path changed.
- Frontend screenshots/video: N/A - no UI changed.
- Real-LLM trajectories: N/A - no agent/action/provider/prompt/model behavior changed.
- Domain artifacts: content-addressed descriptor unit tests prove SHA-256 object naming, tenant/app/batch scoping, default raw-upload expiry, explicit raw-retain metadata, and derived batch-lifecycle metadata.
