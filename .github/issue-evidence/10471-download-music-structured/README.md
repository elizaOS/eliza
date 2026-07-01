# Issue 10471 - Download Music Structured Query Evidence

## Change

- Removed the fallback that treated the entire user message as the `DOWNLOAD_MUSIC` query.
- `handleDownloadMusic` now requires structured `query` or `searchQuery` action parameters.
- Kept selected `media` / `files` context eligibility, but missing structured query now prompts for the song instead of downloading from raw message text.
- Added regression coverage and extended the package core test mock for `getActiveRoutingContextsForTurn`.

## Validation

- Full sync: `bun install` completed with artifact bundle `2026-06-18.1` (`bun-install.log`).
- Focused test: `bun run --cwd plugins/plugin-music test src/actions/downloadMusic.test.ts` (`focused-tests.log`) - pass, 4 tests.
- Full plugin test: `bun run --cwd plugins/plugin-music test` (`plugin-music-tests.log`) - pass, 8 files / 44 tests.
- Typecheck: `bun run --cwd plugins/plugin-music typecheck` (`plugin-music-typecheck.log`) - pass.
- Lint: `bun run --cwd plugins/plugin-music lint:check` (`plugin-music-lint.log`) - pass.
- Whitespace: `git diff --check` (`diff-check.log`) - pass.
- Root verify: `bun run verify` (`root-verify.log`) - failed outside this slice after `@elizaos/plugin-music:lint` passed, on unrelated `@elizaos/plugin-suno` formatting drift; process exited 139.

## Evidence Scope Notes

- Live LLM trajectory: N/A. No model API keys were present (`model-key-presence.txt`), and this change is a deterministic action-parameter parser guard covered by unit tests.
- UI screenshots/video/manual app audit: N/A. This change is plugin action routing only and does not touch `packages/app` or shared UI.
- Android/native capture: N/A. No Android, native bridge, or app runtime surface changed.
- Audio walkthrough: N/A. This does not change playback, TTS, STT, voice, or transcript behavior.
