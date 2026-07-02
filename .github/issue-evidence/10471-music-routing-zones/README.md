# Issue #10471 — plugin-music routing and zone commands

## Change proven

- Removed natural-language command parsing from `MANAGE_ROUTING` and `MANAGE_ZONES` handlers.
- Routing now executes only from structured action params: `routingAction`, `mode`, `sourceId`, `targetIds`, and optional singular `targetId`.
- Zone management now executes only from structured action params: `operation`, `zoneName`, `targetIds`, and optional singular `targetId`.
- Plain English message text such as `set mode simulcast` or `create zone main-stage with speaker-a` no longer drives behavior by itself.

## Validation

- `focused-routing-zones-test.log`: `bun run --cwd plugins/plugin-music test src/actions/manageRoutingZones.test.ts` — passed, 6 tests.
- `plugin-music-test.log`: `bun run --cwd plugins/plugin-music test` — passed, 46 tests across 8 files.
- `plugin-music-typecheck.log`: `bun run --cwd plugins/plugin-music typecheck` — passed.
- `plugin-music-lint-check.log`: `bun run --cwd plugins/plugin-music lint:check` — passed.
- `git-diff-check.log`: `git diff --check` — passed.
- `root-verify.log`: `bun run verify` — blocked before package validation by existing root type-safety-ratchet baseline drift in core/agent/app-core `?? []`, `?? {}`, and `?? 0` counters.

## Evidence exceptions

- Live LLM trajectory: N/A. This slice removes deterministic natural-language parsers and relies on planner-emitted structured params; `model-key-presence.log` records that supported model API keys were unset in this environment.
- Screenshots/video: N/A. This is backend action dispatch only, with no UI, Android/device, or rendered surface changed.
- Audio capture: N/A. This does not alter audio playback, STT/TTS, wake-word, or device audio behavior.
