# @elizaos/plugin-edge-tts

Free text-to-speech synthesis for Eliza agents using Microsoft Edge TTS — no API key required.

## Purpose / role

Registers a `ModelType.TEXT_TO_SPEECH` model handler that calls Microsoft's Edge TTS WebSocket service via the `node-edge-tts` npm package. The plugin auto-enables when `ELIZA_CLOUD_PROVISIONED=1` or when `config.features.tts` is truthy. It is Node-only; the browser export is a no-op stub that logs a warning.

The plugin is loaded by including `@elizaos/plugin-edge-tts` in the agent's plugin list, or automatically via the elizaOS auto-enable engine (checks `auto-enable.ts`).

## Plugin surface

This plugin registers no actions, providers, evaluators, routes, or events. It registers one model handler:

- **`ModelType.TEXT_TO_SPEECH`** (`src/index.ts`) — accepts a plain string or an `EdgeTTSParams` object; returns a `Buffer` of MP3 (or other configured format) audio. Hard limits: non-empty text, max 5000 characters.

Exported symbols from `src/index.ts`:
- `edgeTTSPlugin` — the `Plugin` object; default export.
- `synthesizeEdgeSpeech(text, overrides?)` — standalone helper that synthesizes without an `AgentRuntime`; reads settings from environment only. Used by pre-agent server routes (e.g. onboarding TTS before an agent exists).
- `EdgeTTSParams`, `EdgeTTSSettings` — types.
- `_test` — internal helpers exposed for unit tests (`resolveVoice`, `speedToRate`, `inferExtension`, `getEdgeTTSSettings`).

## Layout

```
plugins/plugin-edge-tts/
  src/
    index.ts            Main implementation: plugin object, model handler, helpers
    index.node.ts       Node entry — re-exports src/index.ts
    index.browser.ts    Browser stub — no-op plugin + warning log
    types/
      node-edge-tts.d.ts  Hand-written type declarations for node-edge-tts package
  auto-enable.ts        Lightweight auto-enable check (env reads only, no full runtime import)
  index.ts              Barrel — re-exports src/index.ts
  index.node.ts         (root) re-exports src/index.node.ts
  index.browser.ts      (root) re-exports src/index.browser.ts
  __tests__/
    smoke.test.ts       Unit tests (voice mapping, rate conversion, settings validation)
    core-test-mock.ts   Mock AgentRuntime for tests
  build.ts              Bun.build() script (node ESM, browser ESM, node CJS targets)
  vitest.config.ts      Vitest config
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-edge-tts build         # compile dist/ (node + browser)
bun run --cwd plugins/plugin-edge-tts dev           # hot-rebuild via bun --hot build.ts
bun run --cwd plugins/plugin-edge-tts test          # vitest unit suite
bun run --cwd plugins/plugin-edge-tts test:e2e      # live smoke via run-local-plugin-live-smoke.mjs
bun run --cwd plugins/plugin-edge-tts lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-edge-tts lint:check    # biome check (read-only)
bun run --cwd plugins/plugin-edge-tts format        # biome format --write
bun run --cwd plugins/plugin-edge-tts typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-edge-tts clean         # rm dist .turbo tsconfig.tsbuildinfo
```

## Config / env vars

All variables are optional. Resolution order: `runtime.getSetting(key)` → `process.env[key]` → default.

| Variable | Default | Description |
|---|---|---|
| `EDGE_TTS_VOICE` | `en-US-MichelleNeural` | Voice ID; accepts Edge TTS IDs or OpenAI preset names (see below) |
| `EDGE_TTS_LANG` | `en-US` | BCP-47 language code |
| `EDGE_TTS_OUTPUT_FORMAT` | `audio-24khz-48kbitrate-mono-mp3` | Output format string passed to node-edge-tts |
| `EDGE_TTS_RATE` | _(unset)_ | Speech rate (e.g. `+10%`, `-5%`) |
| `EDGE_TTS_PITCH` | _(unset)_ | Pitch (e.g. `+5Hz`, `-10Hz`) |
| `EDGE_TTS_VOLUME` | _(unset)_ | Volume (e.g. `+20%`, `-10%`) |
| `EDGE_TTS_PROXY` | _(unset)_ | HTTP proxy URL for the TTS WebSocket connection |
| `EDGE_TTS_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |

OpenAI-style voice name aliases resolved in `resolveVoice()` (src/index.ts):
`alloy→en-US-GuyNeural`, `echo→en-US-ChristopherNeural`, `fable→en-GB-RyanNeural`,
`onyx→en-US-DavisNeural`, `nova→en-US-JennyNeural`, `shimmer→en-US-AriaNeural`.

Auto-enable triggers (`auto-enable.ts`, also duplicated inline in the plugin object):
- `ELIZA_CLOUD_PROVISIONED=1` in env, OR
- `config.features.tts === true` (or object with `enabled !== false`).

## How to extend

This plugin has a single responsibility (TTS model handler). The typical extension points are:

**Change the model handler behaviour** — edit `generateSpeech()` and the `ModelType.TEXT_TO_SPEECH` handler in `src/index.ts`. Both the `params` object and `settings` struct are typed; keep them in sync.

**Add a new voice preset alias** — add an entry to `VOICE_PRESETS` in `src/index.ts` (lowercase key → Edge TTS voice ID string).

**Add a provider or action to this plugin** — add the implementation file under `src/`, import it in `src/index.ts`, and add it to the `edgeTTSPlugin` object's `providers` or `actions` array. Follow the root `AGENTS.md` architecture rules.

**Add a test** — add a `TestSuite` entry to the `tests` array inside `edgeTTSPlugin` in `src/index.ts`, or add a vitest file under `__tests__/`. Use `core-test-mock.ts` for a minimal `IAgentRuntime` mock.

## Conventions / gotchas

- **Node-only.** The browser build (`src/index.browser.ts`) exports an empty plugin stub. Do not add Node.js file system or WebSocket code to the browser entry point.
- **Temp file I/O.** `node-edge-tts` writes audio to a temp file (via `mkdtempSync`); the plugin reads it back and cleans up in a `finally` block. If cleanup fails, the error is silently ignored to avoid masking the audio result.
- **5000-character limit.** Enforced explicitly before calling the TTS service. The upstream service has its own practical limit near this value; errors above it are opaque network failures.
- **Type declarations.** `node-edge-tts` ships no TypeScript types. The hand-written declarations in `src/types/node-edge-tts.d.ts` are the authoritative type source for this package.
- **`synthesizeEdgeSpeech`** passes `null` as the runtime to `getEdgeTTSSettings`, so it reads only from `process.env`. Do not call it inside an agent handler where a runtime is available — use `runtime.useModel(ModelType.TEXT_TO_SPEECH, ...)` instead.
- **Triple build targets.** `build.ts` produces `dist/node/` (ESM), `dist/browser/` (ESM), and `dist/cjs/` (CJS) bundles. The `exports` map in `package.json` selects the right bundle per environment. Keep `index.node.ts` and `index.browser.ts` as thin re-exports; all logic lives in `src/index.ts` (node) or `src/index.browser.ts` (browser stub).
