# @elizaos/plugin-streaming

RTMP live streaming for Eliza agents: Twitch, YouTube Live, X (Twitter), pump.fun, custom ingest URLs, and named extra ingests.

## Purpose / role

Adds RTMP streaming control to an Eliza agent. The agent can start, stop, and check status of live streams via the `STREAM` action. The plugin manages the FFmpeg pipeline, screen/audio capture, overlay layout persistence, and TTS-to-stream audio bridging. It is opt-in: `auto-enable.ts` activates it only when at least one streaming destination is configured under the `streaming` key in agent config (or via env vars).

## Plugin surface

**Actions**
- `STREAM` — start/stop/status for twitch, youtube, x, pumpfun; dispatches to `POST /api/stream/live`, `POST /api/stream/offline`, `GET /api/stream/status`; `roleGate: ADMIN`; similes: `START_STREAM`, `STOP_STREAM`, `GO_LIVE`, `GO_OFFLINE`, `STREAM_STATUS`, `IS_LIVE`.

**Providers**
- `streamStatus` — per-turn provider; fetches `GET /api/stream/status` for all four platforms and emits JSON context; `contexts: ["media", "automation"]`.

**Services / singletons** (not registered as elizaOS Services, exported as module singletons)
- `streamManager` (`StreamManager`) — FFmpeg lifecycle; video input modes: `pipe`, `avfoundation`, `screen`, `x11grab`, `file`, `testsrc`; audio sources: `silent`, `system`, `microphone`, `tts`, file path; volume/mute; auto-restart with exponential backoff.
- `ttsStreamBridge` (`TtsStreamBridge`) — generates TTS (ElevenLabs, OpenAI, Edge TTS, local inference) and feeds PCM s16le 24 kHz mono into FFmpeg pipe:3; attach/detach lifecycle follows `streamManager.start()/stop()`.

**Route handler** (not registered in `Plugin.routes`; consumed externally)
- `handleStreamRoute` — handles `/api/stream/*` and `/api/streaming/*` endpoints: frame ingest, MJPEG preview, stream start/stop, status, volume, mute/unmute, destination management, settings persistence, source switching.
- `handleTtsRoutes` — handles `/api/tts/config`, `/api/tts/elevenlabs`, `/api/tts/local-inference`.

## Layout

```
plugins/plugin-streaming/
  package.json            npm metadata, agentConfig env var declarations
  auto-enable.ts          shouldEnable() — activates when a dest is configured
  src/
    index.ts              Plugin export: streamingPlugin (actions, providers, config)
                          Platform preset configs (TWITCH_CFG, YOUTUBE_CFG, X_CFG, PUMPFUN_CFG)
                          Destination factory exports: createTwitchDestination,
                            createYoutubeDestination, createXStreamDestination,
                            createPumpfunDestination, createCustomRtmpDestination,
                            createNamedRtmpDestination
    core.ts               Shared types (StreamingDestination, StreamingPluginConfig,
                            OverlayLayoutData, StreamingBackend)
                          buildPresetLayout() — overlay widget layout factory
                          createStreamingDestination() — direct RTMP destination
                          createCloudRelayDestination() — cloud-relay destination
                          createStreamingPlugin() — per-platform plugin+factory bundle
                          buildStreamOpAction() — builds the STREAM action
                          streamStatusProvider — the streamStatus provider
                          resolveStreamingBackend() — direct vs. cloud selection logic
    api/
      stream-routes.ts    handleStreamRoute(); detectCaptureMode(); ensureXvfb()
                          MJPEG frame store; pipeline start/stop coordination
      stream-persistence.ts  readStreamSettings, writeStreamSettings, readOverlayLayout,
                              writeOverlayLayout, seedOverlayDefaults, validateStreamSettings,
                              getHeadlessCaptureConfig, parseDestinationQuery, safeDestId
      stream-route-state.ts  StreamRouteState interface (destinations map, streamManager ref, etc.)
      streaming-types.ts     Canonical StreamingDestination + OverlayLayoutData interfaces
      streaming-text.ts      mergeStreamingText(), resolveStreamingUpdate() — token-stream merge
      tts-routes.ts          handleTtsRoutes(); local inference + ElevenLabs + config route
    services/
      stream-manager.ts   StreamManager class; streamManager singleton; StreamConfig, AudioSource types
      tts-stream-bridge.ts  TtsStreamBridge class; ttsStreamBridge singleton; resolveTtsConfig();
                             getTtsProviderStatus(); TtsConfig, ResolvedTtsConfig, ITtsStreamBridge
```

## Commands

```bash
bun run --cwd plugins/plugin-streaming build        # tsup + declaration emit
bun run --cwd plugins/plugin-streaming dev          # tsup --watch
bun run --cwd plugins/plugin-streaming test         # vitest run
bun run --cwd plugins/plugin-streaming typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-streaming lint         # biome check --write --unsafe src
bun run --cwd plugins/plugin-streaming lint:check   # biome check src
bun run --cwd plugins/plugin-streaming format       # biome format --write .
bun run --cwd plugins/plugin-streaming clean        # rm dist .turbo tsconfig artifacts
```

## Config / env vars

All are optional. The plugin is a no-op if none are set.

| Env var | Purpose |
|---|---|
| `TWITCH_STREAM_KEY` | Twitch RTMP stream key |
| `YOUTUBE_STREAM_KEY` | YouTube Live stream key |
| `YOUTUBE_RTMP_URL` | Override YouTube RTMP ingest URL |
| `X_STREAM_KEY` | X (Twitter) stream key |
| `X_RTMP_URL` | X RTMP ingest URL (required with X_STREAM_KEY) |
| `PUMPFUN_STREAM_KEY` | pump.fun stream key |
| `PUMPFUN_RTMP_URL` | pump.fun RTMP ingest URL |
| `CUSTOM_RTMP_URL` | Custom RTMP ingest URL |
| `CUSTOM_RTMP_KEY` | Custom RTMP stream key |
| `<PLATFORM>_STREAMING_BACKEND` | `direct` \| `cloud` \| `auto` (default `auto`); e.g. `TWITCH_STREAMING_BACKEND` |
| `ELIZAOS_CLOUD_API_KEY` | Eliza Cloud API key — required for cloud relay mode |
| `ELIZAOS_CLOUD_BASE_URL` | Override Eliza Cloud base URL (default `https://www.elizacloud.ai/api/v1`) |
| `ELIZAOS_CLOUD_ENABLED` | Enable cloud connection check for auto backend selection |
| `STREAM_MODE` | Override capture mode: `pipe`, `x11grab`, `avfoundation`, `screen`, `file` |
| `STREAM_AUDIO_SOURCE` | Audio source: `silent`, `system`, `microphone`, `tts`, or file path |
| `STREAM_AUDIO_DEVICE` | Platform-specific audio device identifier |
| `STREAM_VOLUME` | Volume 0–100 (default `80`) |
| `STREAM_DISPLAY` | X11 display for x11grab mode (default `:99`) |
| `STREAM_VIDEO_DEVICE` | avfoundation video device index (default `3`) |
| `STREAM_CAPTURE_URL` | URL for headless browser capture (file/x11grab fallback) |
| `STREAM_THEME` | Overlay theme (fallback if not in stream-settings.json) |
| `STREAM_AVATAR_INDEX` | Overlay avatar index (fallback if not in stream-settings.json) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (TTS audio for streams) |
| `OPENAI_API_KEY` | OpenAI API key (TTS audio for streams) |
| `ELIZA_DATA_DIR` | Data root; stream settings + overlay layouts land in `<dir>/stream/` |

Overlay layout and visual settings are persisted in `<ELIZA_DATA_DIR>/stream/` (default `./data/stream/`). Per-destination layout files are named `overlay-layout-<destId>.json`.

## How to extend

**Add a new action:**
1. Write the action object (implementing `Action` from `@elizaos/core`) in `src/core.ts` or a new file under `src/api/`.
2. Add it to `streamingPlugin.actions` array in `src/index.ts`.

**Add a new provider:**
1. Write the provider object (implementing `Provider`) in `src/core.ts` or a new file.
2. Add it to `streamingPlugin.providers` array in `src/index.ts`.

**Add a new streaming platform preset:**
1. Define a `StreamingPluginConfig` constant in `src/index.ts` (see `TWITCH_CFG` pattern).
2. Call `createStreamingPlugin(cfg)` to get `{ plugin, createDestination }`.
3. Export a `create<Platform>Destination` factory function.
4. Optionally add the platform to `STREAMING_PLATFORMS` in `src/core.ts` so `STREAM` action and `streamStatus` provider cover it.

**Add a new stream route:**
Add a conditional branch in `handleStreamRoute()` in `src/api/stream-routes.ts`. The function returns `true` when it handles the request, `false` to fall through.

## Conventions / gotchas

- **FFmpeg is a hard runtime dependency.** `streamManager.start()` runs `ffmpeg -version` at startup and throws with an install hint if not found. There is no bundled binary.
- **Cloud relay vs. direct:** `resolveStreamingBackend()` auto-selects cloud relay when Eliza Cloud is connected AND no local stream key is set. Force a mode with `<PLATFORM>_STREAMING_BACKEND=direct|cloud`.
- **TTS audio uses pipe:3.** `TtsStreamBridge` attaches to FFmpeg's 4th stdio fd. The PCM format is fixed: s16le, 24 kHz, mono. Audio is decoded via a second FFmpeg subprocess spawned per speak call.
- **`handleStreamRoute` and `handleTtsRoutes` are not in `Plugin.routes`.** They are imperative route-handler functions intended to be wired into an HTTP server by the consuming runtime. The plugin object registers only `actions` and `providers`.
- **Overlay layouts** are seeded from `destination.defaultOverlayLayout` on first stream start per destination, then persisted as JSON files. Subsequent starts read from the file.
- **`streamingText.ts`** (`mergeStreamingText`, `resolveStreamingUpdate`) is a standalone utility for de-duplicating overlapping token-stream chunks; it has no dependency on streaming state.
- **`auto-enable.ts`** is a separate entry point referenced by the elizaOS plugin auto-enable system. It must stay import-free from the full plugin runtime (no `@elizaos/core` service imports).
- **`node-edge-tts`** is an optional peer dependency for Edge TTS; the bridge catches the import error and surfaces a clear message if it is not installed.
