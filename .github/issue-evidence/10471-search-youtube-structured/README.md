# Issue 10471 - Search YouTube Structured Query Evidence

## Change

- Removed English regex fallback query extraction from `SEARCH_YOUTUBE`.
- `validateSearchYouTube` and `handleSearchYouTube` now require structured `query` or `searchQuery` action parameters.
- Added regression coverage for English prose without structured parameters, non-English text with structured parameters, missing-query handler behavior, and successful structured search execution.

## Validation

- Full sync: `bun install` completed with artifact bundle `2026-06-18.1` (`bun-install.log`).
- Focused test: `bun run --cwd plugins/plugin-music test src/actions/searchYouTube.test.ts` (`focused-tests.log`) - pass, 4 tests.
- Full plugin test: `bun run --cwd plugins/plugin-music test` (`plugin-music-tests.log`) - pass, 8 files / 44 tests.
- Typecheck: `bun run --cwd plugins/plugin-music typecheck` (`plugin-music-typecheck.log`) - pass.
- Lint: `bun run --cwd plugins/plugin-music lint:check` (`plugin-music-lint.log`) - pass.
- Whitespace: `git diff --check` (`diff-check.log`) - pass.
- Root verify: `bun run verify` (`root-verify.log`) - failed outside this slice after `@elizaos/plugin-music:lint` passed, on unrelated `@elizaos/ui` and `@elizaos/cloud-api` formatting/import-order drift; process exited 139.

## Evidence Scope Notes

- Live LLM trajectory: N/A. No model API keys were present (`model-key-presence.txt`), and this change is a deterministic action-parameter parser guard covered by unit tests.
- UI screenshots/video/manual app audit: N/A. This change is plugin action routing only and does not touch `packages/app` or shared UI.
- Android/native capture: N/A. No Android, native bridge, or app runtime surface changed.
- Audio walkthrough: N/A. This does not change playback, TTS, STT, voice, or transcript behavior.
