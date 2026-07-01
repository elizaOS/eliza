# Issue #10471 - DOCUMENT Structured Values Follow-Up

Branch: `fix/10471-documents-structured-values`

## What Changed

- Removed the remaining English regex value transforms in `DOCUMENT` handling:
  - `getQuery()` no longer strips `search/find/lookup... documents...` from `message.content.text`.
  - `getCleanWriteText()` no longer strips `save/store/write...` prefixes from `message.content.text`.
- `DOCUMENT_SUBACTIONS.search` now requires structured/extracted `query`.
- `DOCUMENT_SUBACTIONS.write` now requires structured/extracted `text`.
- UUID, URL, and file-path structural extractors are still preserved for read/edit/delete/import paths.

## Validation

- `bun run --cwd packages/core test src/features/documents` passed: 6 files / 58 tests.
- `bunx @biomejs/biome check packages/core/src/features/documents/actions.ts packages/core/src/features/documents/__tests__/actions-routing.test.ts` passed.
- `bun run --cwd packages/core typecheck` passed.
- `git diff --check` passed.

## Evidence Scope Notes

- Real LLM trajectory: not captured in this environment; no supported model API key was present (`model-key-presence.txt`). The new tests exercise the shared extractor boundary with deterministic extractor output and prove the handler no longer performs English prefix stripping.
- Root `bun run verify`: not run after the focused checks. `bun run install:light` failed with `ENOSPC` during dependency linking, and the filesystem remained critically low on free space (`disk-space.txt`).
- UI screenshots/video/app audit: N/A, no `packages/app` or shared UI changed.
- Frontend logs, Android/native capture, audio walkthrough: N/A, this is core backend action routing only.
- Domain artifacts: N/A, the deterministic unit path uses a stubbed `DocumentService`; no DB/document store artifact is produced by this regression test.
