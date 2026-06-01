# @elizaos/plugin-elevenlabs

Provides ElevenLabs-powered text-to-speech (TTS) and speech-to-text (STT) model handlers for Eliza agents.

## Purpose / role

This plugin registers `ModelType.TEXT_TO_SPEECH` and `ModelType.TRANSCRIPTION` handlers with the elizaOS runtime so any agent that loads it can call `runtime.useModel(ModelType.TEXT_TO_SPEECH, ...)` or `runtime.useModel(ModelType.TRANSCRIPTION, ...)` backed by the ElevenLabs API. It is opt-in: add `@elizaos/plugin-elevenlabs` to the agent's `plugins` list in character config. It has no actions, providers, evaluators, services, or routes — only model handlers.

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Model handler | `ModelType.TEXT_TO_SPEECH` | Streams audio from ElevenLabs TTS API, returns `Uint8Array` |
| Model handler | `ModelType.TRANSCRIPTION` | Sends audio to ElevenLabs Scribe STT API, returns transcript string |
| Tests | inline plugin test suite | Validates API key, voice settings, STT config, and (if key present) live connectivity |

No actions, providers, evaluators, services, routes, or events are registered.

## Layout

```
plugins/plugin-elevenlabs/
  src/
    index.ts           Plugin definition, all model handler logic, settings helpers
    index.node.ts      Node entry — re-exports index.ts (used as module/cjs)
    index.browser.ts   Browser entry — re-exports index.ts (used as browser build)
  __tests__/
    streaming.test.ts  Functional tests for TTS streaming path (chunk draining, SDK params, error propagation)
  build.ts             Bun build script
  package.json
```

Everything lives in `src/index.ts`. There are no separate action or service files.

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-elevenlabs build          # compile dist/
bun run --cwd plugins/plugin-elevenlabs dev            # watch build (--hot)
bun run --cwd plugins/plugin-elevenlabs test           # run __tests__
bun run --cwd plugins/plugin-elevenlabs clean          # remove dist/
bun run --cwd plugins/plugin-elevenlabs lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-elevenlabs lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-elevenlabs format         # biome format --write
bun run --cwd plugins/plugin-elevenlabs format:check   # biome format (read-only)
bun run --cwd plugins/plugin-elevenlabs typecheck      # tsgo --project tsconfig.json --noEmit
```

## Config / env vars

Settings are resolved from `runtime.getSetting(key)` first, then `process.env[key]`. All are read at call time inside the model handler — no service startup required.

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `ELEVENLABS_API_KEY` | **Yes** | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | No | `EXAVITQu4vr4xnSDxMaL` | Voice ID for TTS |
| `ELEVENLABS_MODEL_ID` | No | `eleven_monolingual_v1` | TTS model ID |
| `ELEVENLABS_VOICE_STABILITY` | No | `0.5` | 0–1 |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | No | `0.75` | 0–1 |
| `ELEVENLABS_VOICE_STYLE` | No | `0` | 0–1 |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | No | `true` | boolean string |
| `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY` | No | `0` | 0–4 |
| `ELEVENLABS_OUTPUT_FORMAT` | No | `mp3_44100_128` | ElevenLabs format enum |
| `ELEVENLABS_BROWSER_URL` | No | — | Proxy base URL for browser builds; skips API key requirement |
| `ELEVENLABS_STT_MODEL_ID` | No | `scribe_v1` | STT model ID |
| `ELEVENLABS_STT_LANGUAGE_CODE` | No | — | Leave unset for auto-detect |
| `ELEVENLABS_STT_TIMESTAMPS_GRANULARITY` | No | `word` | `none` / `word` / `character` |
| `ELEVENLABS_STT_DIARIZE` | No | `false` | boolean string |
| `ELEVENLABS_STT_NUM_SPEAKERS` | No | — | 1–32; only used when diarize=true |
| `ELEVENLABS_STT_TAG_AUDIO_EVENTS` | No | `false` | boolean string |

## How to extend

This plugin has no extensible action registry — it only registers model handlers. To add a new model type handler:

1. Open `src/index.ts`.
2. Add a new key under the `models` object on `elevenLabsPlugin` using a `ModelType.*` constant from `@elizaos/core`.
3. Implement the handler as `async (runtime: IAgentRuntime, input: <InputType>) => <OutputType>`.
4. Document the new env vars in `package.json` under `agentConfig.pluginParameters`.

To add an action, provider, or service (not currently present), add an `actions`, `providers`, or `services` array to the plugin object following the pattern in the root AGENTS.md and elizaOS core docs.

## Conventions / gotchas

- **Browser builds:** `ELEVENLABS_BROWSER_URL` redirects requests to a server-side proxy that injects the API key. In browser mode with no `ELEVENLABS_BROWSER_URL`, the API key falls back to the placeholder `"sk-proxy"` — the call will fail unless a proxy is configured.
- **Output format:** The default output format is `mp3_44100_128` (browser-safe). Avoid `pcm_*` formats in browser contexts; PCM is fine for Node/server deployments. Pass an explicit `format` field in the `useModel` input object to override per-call.
- **TTS input shape:** `runtime.useModel(ModelType.TEXT_TO_SPEECH, ...)` accepts either a plain string or `{ text, model?, voiceId?, format?, instructions? }`.
- **STT input shape:** Accepts a URL string, a `Buffer`, or `{ audioUrl: string; prompt?: string }`.
- **Format validation:** `parseTtsOutputFormat` and `parseSttModelId` throw on unrecognized enum values — use values from the `@elevenlabs/elevenlabs-js/api` enums.
- **No WAV support:** WAV header utilities were removed; use mp3 or pcm formats directly.
- **SDK dependency:** Uses `@elevenlabs/elevenlabs-js` ^2.16.0 (official ElevenLabs SDK). All API calls go through `ElevenLabsClient`.
