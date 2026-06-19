# @elizaos/plugin-xr

WebXR audio/video streaming for elizaOS — Quest 3 and XReal glasses.

## Purpose / role

Adds a WebXR streaming surface to an Eliza agent: a WebSocket server accepts
connections from XR headsets (Quest 3, XReal, or a browser simulator), pipes
microphone audio through the runtime's TRANSCRIPTION model, and routes the
transcript through the standard message pipeline. Voice responses are generated
via the TEXT_TO_SPEECH model and sent back as binary audio frames. The plugin
is opt-in — register `xrPlugin` in your character's plugins array.

## Plugin surface

**Service**
- `XRSessionService` (`xr-session`) — WebSocket server on port 31338 (default).
  Manages per-connection lifecycle, delegates audio to `AudioPipeline` and
  camera frames to `VisionPipeline`, routes transcripts into the agent message
  pipeline, and sends TTS audio back to the headset.

**Actions**
- `XR_QUERY_VISION` — describes what the user's XR camera currently sees
  (calls `VisionPipeline.describeFrame` → `ModelType.IMAGE_DESCRIPTION`).
  Only validates when a recent camera frame exists.
- `XR_OPEN_VIEW` — opens a named view panel on the headset (sends
  `view_open` control message).
- `XR_CLOSE_VIEW` — closes a named view (or all views if no id given).
- `XR_SWITCH_VIEW` — brings a view to the foreground without closing others.
- `XR_LIST_VIEWS` — enumerates views with `viewType: "xr"` from all loaded
  plugins and optionally sends the catalog to the device.
- `XR_RESIZE_VIEW` — resizes/repositions the active panel (`scale`,
  `distance`, `fullscreen` options).

**Provider**
- `XR_SESSION` (`xr-context.ts`) — injects connected device list and camera
  state into the agent context block when at least one headset is connected.

**Routes** (all under `/api/xr/`)
- `GET /xr/status` — JSON list of connected sessions and camera-frame state.
- `GET /xr/connect` — HTML page with QR code for pairing a headset.
- `GET /xr/views` — JSON list of all `viewType: "xr"` views registered by
  loaded plugins, plus active connections.
- `GET /xr/view-host/:id` — self-contained HTML shell that dynamically imports
  a plugin view bundle and renders it with an XR-optimised chrome.
- `GET /xr/simulator.js` — serves the built WebXR emulator bundle (only
  available after `bun run build:all`).

## Layout

```
plugins/plugin-xr/
  src/
    index.ts                  Plugin entry — exports xrPlugin and public types
    protocol.ts               Wire types: XRClientControl, XRServerControl,
                              XRBinaryHeader, XRTTSAudioHeader; encode/decode helpers
    actions/
      xr-query-vision.ts      XR_QUERY_VISION action
      xr-view-actions.ts      XR_OPEN/CLOSE/SWITCH/LIST/RESIZE_VIEW actions
    providers/
      xr-context.ts           XR_SESSION provider
    services/
      xr-session-service.ts   XRSessionService (WebSocket server, main orchestrator)
      audio-pipeline.ts       AudioPipeline — buffers audio chunks, flushes to
                              TRANSCRIPTION model after 2 s or 1.5 s silence
      vision-pipeline.ts      VisionPipeline — stores latest camera frame (max age
                              10 s), calls IMAGE_DESCRIPTION model on demand
    routes/
      xr-status.ts            GET /xr/status
      xr-connect.ts           GET /xr/connect
      xr-views.ts             GET /xr/views
      xr-view-host.ts         GET /xr/view-host/:id
      xr-simulator-route.ts   GET /xr/simulator.js
    __tests__/
      audio-pipeline.test.ts
      protocol.test.ts
      vision-pipeline.test.ts
      xr-bundle-coverage.test.ts
      xr-feature-parity.test.ts
      xr-functional-parity.test.ts
      xr-view-host.test.ts
      xr-view-host-http.test.ts
  simulator/                  Browser-side WebXR emulator (Vite build)
```

## Commands

```bash
bun run --cwd plugins/plugin-xr typecheck
bun run --cwd plugins/plugin-xr lint
bun run --cwd plugins/plugin-xr test
bun run --cwd plugins/plugin-xr build
bun run --cwd plugins/plugin-xr build:all    # also builds simulator/
bun run --cwd plugins/plugin-xr simulator:build
bun run --cwd plugins/plugin-xr simulator:watch
bun run --cwd plugins/plugin-xr clean
```

## Config / env vars

| Var | Default | Required | Purpose |
|-----|---------|----------|---------|
| `XR_WS_PORT` | `31338` | no | WebSocket server port |
| `XR_AGENT_URL` | `http://localhost:<agent-port>` | no | Public base URL sent to the headset for view bundles |
| `XR_APP_URL` | derived from `VITE_PORT` | no | URL shown on the `/xr/connect` pairing page |

The plugin sets `config: { XR_WS_PORT: 31338 }` in the Plugin object so the
runtime exposes it via `runtime.getSetting("XR_WS_PORT")`.

The agent must have a TRANSCRIPTION model and TEXT_TO_SPEECH model configured
(e.g., via `@elizaos/plugin-openai` or a local inference plugin) for audio
streaming to work. IMAGE_DESCRIPTION is required for `XR_QUERY_VISION`.

## How to extend

**Add an action** — create `src/actions/<name>.ts`, implement `Action` from
`@elizaos/core`, get `XRSessionService` via
`runtime.getService<XRSessionService>(XR_SERVICE_TYPE)`, then add the import
and the object to the `actions` array in `src/index.ts`.

**Add a provider** — create `src/providers/<name>.ts`, implement `Provider`,
add to `providers` array in `src/index.ts`.

**Add a route** — create `src/routes/<name>.ts`, implement `Route`, add to
`routes` array in `src/index.ts`.

**Expose a view in XR** — in any other plugin, add a `views` array entry with
`viewType: "xr"`. `XR_LIST_VIEWS` and `GET /xr/views` collect views with this
field across all loaded plugins at runtime.

## Conventions / gotchas

- **WebXR requires HTTPS on device.** The `/xr/connect` page warns when the
  URL is plain HTTP. Use a local tunnel (e.g., `cloudflared`) and set
  `XR_APP_URL` to the HTTPS tunnel URL.
- **Binary frame framing** is defined in `src/protocol.ts`: 4-byte big-endian
  header length, then UTF-8 JSON header, then raw payload. Use
  `encodeBinaryFrame` / `decodeBinaryFrame` from that module — do not
  reimplement the framing.
- **Audio buffering** — `AudioPipeline` accumulates chunks and flushes after
  2 000 ms of audio or 1 500 ms of silence. Chunks shorter than 512 bytes are
  dropped. `pcm-f32` encoding (ScriptProcessorNode fallback) is wrapped in a
  WAV header before being passed to TRANSCRIPTION.
- **Simulator bundle** — `simulator/` is a separate Vite project. Run
  `bun run build:all` (or `simulator:build`) before the `/xr/simulator.js`
  route will serve anything. The route returns 404 until the bundle exists.
- **`XR_AGENT_URL`** must be a reachable URL from inside the XR headset
  browser when loading view bundles. `localhost` will only work when testing
  on the same machine via the browser simulator.
- See repo root `AGENTS.md` for repo-wide architecture rules, logger
  conventions, ESM requirements, and naming standards.
