# Issue #10471 — Playlist Operation Routing

Branch: `fix/10471-playlist-op-structured`

Base at validation: `origin/develop` `ebed3de42a9a1febffbe97cbf0526164aa0b0460`

## What changed

- Removed `PLAYLIST_OP` English message-text operation inference for save/load/delete/add.
- Removed playlist-name extraction from English message prose and quoted text.
- Removed the add-song fallback regex that parsed `add <song> to <playlist>` from `message.content.text`.
- Playlist operations now route from structured params (`subaction`, `playlistOp`, `op`) and structured names (`playlistName`, `name`, `playlist`); add uses structured song/query params.

## Validation

- `bun install --no-save --ignore-scripts` completed after rebasing.
- `bun run --cwd plugins/plugin-suno build` passed.
- `bun run --cwd plugins/plugin-music test src/actions/playlistOp.test.ts` passed: 4 tests.
- `bun run --cwd plugins/plugin-music test` passed: 44 tests across 8 files.
- `bun run --cwd plugins/plugin-music typecheck` passed.
- `bun run --cwd plugins/plugin-music lint:check` passed.
- `git diff --check` passed.
- `bun run verify` did not complete: the type-safety ratchet passed, then unrelated workspace lint drift failed in `@elizaos/cloud-shared` and `@elizaos/ui`; the command ended with exit code 139. Full log: `root-verify.log`.

## Evidence Rows

- Real LLM trajectory: N/A. This deterministic parser-removal slice is covered by action tests and does not add or change model prompts. No supported model API key was present; see `model-key-presence.txt`.
- Backend logs: command logs attached in this directory.
- Frontend logs/screenshots/video: N/A, no UI or app route changed.
- Android/native/audio capture: N/A, no Android/native/audio surface changed.
- Domain artifacts: N/A, no DB/memory/files/chain state is produced by this parser-removal refactor.
