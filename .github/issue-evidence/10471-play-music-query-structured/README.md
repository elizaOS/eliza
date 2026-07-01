# Issue #10471 - PLAY_MUSIC_QUERY structured query validation

Branch: `fix/10471-play-music-query-structured`

## What changed

- Removed the English keyword and regex validator from `PLAY_MUSIC_QUERY`.
- `PLAY_MUSIC_QUERY` now validates only a structured `query` or `searchQuery` option, while still rejecting direct YouTube URLs so the URL/audio paths can handle them.
- The handler no longer falls back to `message.content.text`; missing structured query input returns a prompt asking for the query parameter.
- `MUSIC_LIBRARY` now passes normalized options into `validatePlayMusicQuery` so `subaction=play_query` inference can use structured parameters.

## Validation

- `focused-play-music-query-test.log` - `vitest run src/actions/playMusicQuery.test.ts`: 1 file / 5 tests passed.
- `full-plugin-music-test.log` - `plugins/plugin-music` full test suite: 14 files / 88 tests passed.
- `plugin-music-typecheck.log` - `plugins/plugin-music` typecheck passed.
- `plugin-music-lint-check.log` - `plugins/plugin-music` Biome check passed.
- `plugin-music-build.log` - `plugins/plugin-music` build passed.
- `git-diff-check.log` - `git diff --check origin/develop...HEAD` passed.
- `root-verify.log` - root `bun run verify` attempted; failed on pre-existing `trajectory-viewer#lint` a11y findings in `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/src/components/LandingPage.tsx` lines 595 and 702, unrelated to this branch.

## Evidence gaps / N/A

- Live model trajectory: blocked in this environment because no supported live model endpoint/API key is present. See `model-key-presence.txt`.
- Screenshots / screen recording / audio: N/A. This branch only changes a Discord/music action validator and handler parameter path; no `packages/app` UI or audio-rendering behavior changed.
