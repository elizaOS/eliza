# Issue #10470 — plugin-music umbrella dispatch

## Change proven

- Replaced the MUSIC umbrella playback fallback that routed natural-language text through `inferOpFromText` / English transport regexes.
- When no explicit `action` / `op` / `subaction` is supplied, the dispatcher now asks `runtime.useModel(ModelType.TEXT_SMALL)` for a structured `<response><action>...</action></response>` enum and parses it with `parseKeyValueXml`.
- If a live model returns a canonical action enum in prose instead of XML, the dispatcher recovers that enum from the model output only when it is unambiguous. It still never falls back to regexes over the user message.
- `validate()` remains structural only: explicit action parameters or selected music context. It does not call the model or classify natural-language text.
- Explicit params and structural machine-format checks still take precedence over the model extraction fallback.
- Scope: this de-Englishes the umbrella routing decision only. The sub-handlers it dispatches to still own their own parameter handling.

## Validation

- `live-ollama-music-subaction-trajectory.jsonl`: live local Ollama `llama3.2:3b` calls, manually reviewed. ES pause, ZH skip, EN queue_view, and FR queue_add all parsed to the expected MUSIC enum.
- `focused-music-action-test.log`: `bun run --cwd plugins/plugin-music test src/actions/music.test.ts` — passed, 20 tests.
- `plugin-music-test.log`: `bun run --cwd plugins/plugin-music test` — passed, 13 files / 76 tests.
- `plugin-music-build.log`: `bun run --cwd plugins/plugin-music build` — passed.
- `plugin-music-typecheck.log`: `bun run --cwd plugins/plugin-music typecheck` — passed.
- `plugin-music-lint-check.log`: `bun run --cwd plugins/plugin-music lint:check` — passed.
- `git-diff-check.log`: `git diff --check` — passed.
- `root-verify.log`: `bun run verify` — blocked at the repo-wide type-safety ratchet baseline; see log.

## Evidence exceptions

- Hosted model API keys: unset in this environment; see `model-key-presence.log`. Live model evidence used the running local Ollama server instead.
- Screenshots/video: N/A. This change is backend action dispatch in `plugins/plugin-music`; no UI surface or Android/device surface changed.
- Audio capture: N/A. This does not alter STT/TTS, audio generation, playback rendering, latency, wake-word, or device audio behavior. It only changes subaction classification before dispatch.
