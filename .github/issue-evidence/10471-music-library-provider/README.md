# #10471 music library provider evidence

## Change

- Removed the English regex gate that decided whether `MUSIC_LIBRARY` returned a full library listing or a compact recent-track shape.
- The provider now returns one deterministic `music_library` JSON shape whenever the provider is selected by `media` / `knowledge` context.
- Added a regression proving English and Japanese requests receive the same structured provider shape and no `recent_music` fallback.

## Validation

- `music-library-provider-test.log` — focused provider test passed.
- `music-test.log` — full `plugins/plugin-music` test suite passed (14 files / 84 tests) after building `@elizaos/plugin-suno`.
- `suno-build.log` — built `@elizaos/plugin-suno`, required for the music umbrella tests to resolve.
- `music-typecheck.log` — `plugins/plugin-music` typecheck passed.
- `music-lint-check.log` — `plugins/plugin-music` lint check passed.
- `music-build.log` — `plugins/plugin-music` build passed.
- `diff-check.log` — branch diff whitespace check passed.
- `root-verify.log` — root `bun run verify` was attempted after rebasing. It passed the type-safety ratchet and reached Turbo lint/typecheck; it failed outside this slice on `trajectory-viewer#lint` ambiguous anchor text in `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/src/components/LandingPage.tsx`. The log shows `@elizaos/plugin-music:lint` was scheduled in the root run; scoped music lint already passed in `music-lint-check.log`.

## Evidence notes

- Live LLM trajectory: N/A for this deterministic provider-shape cleanup, and no supported model API key is present; see `model-key-presence.txt`.
- Screenshots / screen recording: N/A for this backend provider-context change; no `packages/app` UI or rendered view code changed.
- Audio capture: N/A. This does not change playback, STT, TTS, or generated audio.
