# Issue #10470 — plugin-music umbrella dispatch

## Change proven

- Replaced the MUSIC umbrella playback fallback that routed natural-language text through `inferOpFromText` / English transport regexes.
- When no explicit `action` / `op` / `subaction` is supplied, the dispatcher now asks `runtime.useModel(ModelType.TEXT_SMALL)` for a structured `<response><action>...</action></response>` enum and parses it with `parseKeyValueXml`.
- `validate()` remains structural only: explicit action parameters or selected music context. It does not call the model or classify natural-language text.
- Explicit params and structural machine-format checks still take precedence over the model extraction fallback.
- Scope: this de-Englishes the **umbrella routing decision** only. The sub-handlers it dispatches to (playAudio / playbackOp / musicLibrary / playlistOp) still contain their own English keyword logic and are out of scope for this change.

## Validation

- `focused-music-action-test.log`: `bun run --cwd plugins/plugin-music test src/actions/music.test.ts` — passed, 15 tests (incl. model-extraction error/edge paths: reject, blank response, markdown-fenced response).
- `plugin-music-test.log`: `bun run --cwd plugins/plugin-music test` — passed.
- `plugin-music-typecheck.log`: `bun run --cwd plugins/plugin-music typecheck` — passed.
- `plugin-music-lint-check.log`: `bun run --cwd plugins/plugin-music lint:check` — passed.
- `git-diff-check.log`: `git diff --check` — passed.
- `root-verify.log`: `bun run verify` — blocked before package validation by existing root type-safety-ratchet baseline drift in core/agent/app-core `?? []`, `?? {}`, and `?? 0` counters.

## Evidence exceptions

- Live LLM trajectory: N/A in this environment. `model-key-presence.log` records that the supported model API keys checked for this run were unset.
- Screenshots/video: N/A. This change is backend action dispatch in `plugins/plugin-music`; no UI surface or Android/device surface changed.
- Audio capture: N/A. This does not alter STT/TTS, audio generation, playback rendering, latency, wake-word, or device audio behavior. It only changes subaction classification before dispatch.
