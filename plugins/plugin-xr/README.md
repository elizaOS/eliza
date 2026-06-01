# @elizaos/plugin-xr

WebXR audio/video streaming for elizaOS — connects Quest 3, XReal glasses, or
any WebXR-capable browser to an Eliza agent.

## What it does

- Opens a WebSocket server (default port 31338) that XR headsets connect to.
- Streams microphone audio from the headset, transcribes it via the runtime's
  TRANSCRIPTION model, and routes the transcript through the agent's normal
  message pipeline.
- Sends voice responses back to the headset as TTS audio (TEXT_TO_SPEECH model).
- Captures camera frames from the headset and can describe them using the
  IMAGE_DESCRIPTION model (`XR_QUERY_VISION` action).
- Manages floating view panels on the headset — open, close, switch, resize,
  and list views that other plugins have declared with `viewType: "xr"`.

## Capabilities added to an Eliza agent

| Action | What it does |
|--------|-------------|
| `XR_QUERY_VISION` | Describes what the user's XR camera currently sees |
| `XR_OPEN_VIEW` | Opens a named floating panel on the headset |
| `XR_CLOSE_VIEW` | Closes a named panel (or all panels) |
| `XR_SWITCH_VIEW` | Brings a panel to the foreground |
| `XR_LIST_VIEWS` | Lists all XR-capable views and sends a launcher catalog to the device |
| `XR_RESIZE_VIEW` | Resizes or repositions the active panel |

The `XR_SESSION` context provider automatically injects connected-device status
and camera state into every conversation turn when a headset is connected.

## HTTP routes

| Route | Purpose |
|-------|---------|
| `GET /api/xr/status` | JSON status of connected sessions |
| `GET /api/xr/connect` | HTML pairing page with QR code for the headset browser |
| `GET /api/xr/views` | JSON list of all registered XR views |
| `GET /api/xr/view-host/:id` | Self-contained XR shell page for a specific view |
| `GET /api/xr/simulator.js` | WebXR emulator bundle for testing (after build) |

## Enabling the plugin

Add `@elizaos/plugin-xr` to your character's plugin list:

```json
{
  "name": "my-agent",
  "plugins": ["@elizaos/plugin-xr"]
}
```

The plugin also requires a character configuration that loads:
- A TRANSCRIPTION model provider (for speech-to-text)
- A TEXT_TO_SPEECH model provider (for voice responses)
- An IMAGE_DESCRIPTION model provider (for `XR_QUERY_VISION`)

## Configuration

| Environment variable | Default | Purpose |
|---------------------|---------|---------|
| `XR_WS_PORT` | `31338` | WebSocket server port |
| `XR_AGENT_URL` | `http://localhost:<agent-port>` | Public base URL used by the headset to load view bundles — must be reachable from the device |
| `XR_APP_URL` | derived from `VITE_PORT` | URL shown on the `/api/xr/connect` pairing page |

## Connecting a headset

1. Start the agent with this plugin enabled.
2. Open `http://localhost:31337/api/xr/connect` in a browser (adjust port to
   your agent's API port).
3. Scan the QR code with your Quest 3 or XReal browser, or navigate to the
   shown URL.
4. Allow microphone and camera access when prompted.
5. The agent will start receiving audio immediately.

> **Note:** WebXR APIs require HTTPS on physical devices. For local
> development, run a tunnel (e.g., `cloudflared tunnel`) and set `XR_APP_URL`
> to the HTTPS tunnel URL before starting the agent.

## Building the simulator

The `simulator/` sub-project provides a browser-side WebXR emulator for
Playwright tests.

```bash
bun run --cwd plugins/plugin-xr build:all
# or just the simulator:
bun run --cwd plugins/plugin-xr simulator:build
```

After building, `GET /api/xr/simulator.js` serves the emulator bundle.

## Wire protocol

The plugin uses a custom binary framing on top of WebSocket:

- **Text frames** — JSON control messages (`XRClientControl` / `XRServerControl`).
- **Binary frames** — 4-byte big-endian header length, UTF-8 JSON header
  (`XRAudioHeader` or `XRFrameHeader`), then raw payload (audio or JPEG/WebP).

The wire types (`XRClientControl`, `XRServerControl`, `XRBinaryHeader`,
`XRTTSAudioHeader`, `XRPanelConfig`, and the rest of `protocol.ts`) are
re-exported as types from the package root via `export type *`. The framing
helpers `encodeBinaryFrame` / `decodeBinaryFrame` are runtime functions that
live in `src/protocol.ts` and are used internally by the WebSocket server;
they are not part of the package's public runtime exports.
