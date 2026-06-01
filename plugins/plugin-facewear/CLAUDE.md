# @elizaos/plugin-facewear

Unified hearwear plugin for elizaOS — adds XR headset streaming and BLE smartglasses control to any Eliza agent.

## Purpose / role

Registered as `@elizaos/plugin-facewear` (opt-in, category `hardware`). Connects Eliza agents to Meta Quest 3, XReal, Apple Vision Pro (WebXR over WebSocket), and Even Realities G1/G2 smartglasses (BLE via Noble, Web Bluetooth, or a native bridge). Provides bidirectional voice + camera streaming for XR headsets, a full G1 display/control protocol for smartglasses, and in-app view panels for device management.

## Plugin surface

### Services
| Name | Type key | File |
|------|----------|------|
| `FacewearService` | `"facewear"` | `src/services/facewear-service.ts` |
| `XRSessionService` | `"xr-session"` | `src/services/xr-session-service.ts` |
| `SmartglassesService` | `"smartglasses"` | `src/services/smartglasses-service.ts` |

### Actions
| Action name | File | What it does |
|-------------|------|--------------|
| `FACEWEAR_CONNECT` | `actions/facewear-connect.ts` | Emit device-specific connection instructions |
| `FACEWEAR_DEBUG` | `actions/facewear-debug.ts` | Dump diagnostics for all services |
| `SMARTGLASSES_CONTROL` (`facewearControlAction`) | `actions/facewear-control.ts` | ~40 Even G1 ops (connect, display, dashboard, nav, translate, notes, Wi-Fi, raw, …) |
| `SMARTGLASSES_STATUS` (`facewearStatusAction`) | `actions/facewear-status.ts` | Report full smartglasses state |
| `SMARTGLASSES_DISPLAY_TEXT` (`displayFacewearTextAction`) | `actions/display-text.ts` | Paginate + send text to G1 display |
| `SMARTGLASSES_MICROPHONE` (`facewearMicrophoneAction`) | `actions/microphone.ts` | Enable / disable / toggle G1 mic |
| `XR_OPEN_VIEW` (`facewearOpenViewAction`) | `actions/view-actions.ts` | Open a named view panel on connected headset |
| `XR_CLOSE_VIEW` (`facewearCloseViewAction`) | `actions/view-actions.ts` | Close one or all view panels |
| `XR_SWITCH_VIEW` (`facewearSwitchViewAction`) | `actions/view-actions.ts` | Bring a view to foreground |
| `XR_LIST_VIEWS` (`facewearListViewsAction`) | `actions/view-actions.ts` | Enumerate + optionally send view catalog to headset |
| `XR_RESIZE_VIEW` (`facewearResizeViewAction`) | `actions/view-actions.ts` | Scale / reposition a view panel |
| `XR_QUERY_VISION` (`facewearQueryVisionAction`) | `actions/vision-query.ts` | Describe current XR camera frame |

### Providers
| Name | File | What it injects |
|------|------|-----------------|
| `xrContext` | `providers/facewear-context.ts` | XR device list, audio/camera state; silently returns empty when nothing is connected |
| `smartglassesStatus` | `providers/smartglasses-status.ts` | Full Even G1 status string (transport, mic, battery, Wi-Fi, last event, audio stats) |

### Routes
| Method + path | File | Purpose |
|---------------|------|---------|
| `GET /xr/status` | `routes/status.ts` | JSON list of active XR connections |
| `GET /xr/connect` | `routes/connect.ts` | HTML QR-code pairing page |
| `GET /api/facewear/devices` | `routes/device-config.ts` | JSON list of all device profiles |
| `GET /api/facewear/devices/:id` | `routes/device-config.ts` | Single device profile |
| `GET /api/facewear/status` | `routes/device-config.ts` | Connected device list from `FacewearService` |
| simulator route | `routes/simulator-route.ts` | Simulator UI host |
| view-host route | `routes/view-host.ts` | Serve in-headset view bundles |
| views route | `routes/views.ts` | View catalog endpoint |

### Views
Two registered view surfaces (`gui`/`tui`/`xr` variants):
- `facewear` — `/apps/hearwear` — main hearwear manager (`FacewearView`)
- `smartglasses` — `/apps/smartglasses` — Even Realities pairing + diagnostics (`SmartglassesView`)

## Layout

```
src/
  index.ts                    Plugin object + all exports
  register.ts                 Secondary entry for view-only imports
  status-format.ts            Shared status formatting utilities
  actions/
    facewear-connect.ts       FACEWEAR_CONNECT
    facewear-control.ts       SMARTGLASSES_CONTROL (alias: facewearControlAction)
    facewear-debug.ts         FACEWEAR_DEBUG
    facewear-status.ts        SMARTGLASSES_STATUS (alias: facewearStatusAction)
    display-text.ts           SMARTGLASSES_DISPLAY_TEXT (alias: displayFacewearTextAction)
    microphone.ts             SMARTGLASSES_MICROPHONE (alias: facewearMicrophoneAction)
    view-actions.ts           XR_OPEN/CLOSE/SWITCH/LIST/RESIZE_VIEW (facewear* aliases)
    vision-query.ts           XR_QUERY_VISION (alias: facewearQueryVisionAction)
    xr-view-actions.ts        (additional XR view helpers)
  providers/
    facewear-context.ts       xrContext provider
    smartglasses-status.ts    smartglassesStatus provider
  routes/
    connect.ts                /xr/connect QR page
    device-config.ts          /api/facewear/* REST endpoints
    simulator-route.ts        Simulator UI host
    status.ts                 /xr/status
    view-host.ts              In-headset view host
    views.ts                  View catalog
  services/
    facewear-service.ts       FacewearService — coordinator; serviceType "facewear"
    xr-session-service.ts     XRSessionService — WebSocket server; serviceType "xr-session"
    smartglasses-service.ts   SmartglassesService — BLE G1 driver; serviceType "smartglasses"
    audio-pipeline.ts         AudioPipeline — PCM decode + ASR routing
    vision-pipeline.ts        VisionPipeline — camera frame capture + VLM describe
  devices/
    registry.ts               DEVICE_REGISTRY — profiles for all 4 device types
    apple-vision-pro.ts / even-realities.ts / meta-quest.ts / xreal.ts
  protocol/
    smartglasses.ts           G1 binary protocol (encode* functions, event types)
    xr.ts                     XR WebSocket framing protocol
  transport/
    even-bridge.ts            EvenBridgeTransport — native Android/desktop bridge
    noble.ts                  NobleG1Transport — Node.js BLE via @abandonware/noble
    web-bluetooth.ts          WebBluetoothG1Transport — browser Web Bluetooth API
    mock.ts                   MockSmartglassesTransport — testing stub
    types.ts                  SmartglassesTransport interface
  ui/                         React view components (built by build:views)
emulator/                     Device emulator CLI + WebSocket server
app-xr/                       WebXR browser client (served to headsets)
docs/                         Extended hardware notes (smartglasses.md, etc.)
```

## Commands

```bash
bun run --cwd plugins/plugin-facewear build          # full build (JS + views + types)
bun run --cwd plugins/plugin-facewear build:js       # tsup JS only
bun run --cwd plugins/plugin-facewear build:views    # Vite React view bundles
bun run --cwd plugins/plugin-facewear build:types    # tsc type declarations
bun run --cwd plugins/plugin-facewear typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-facewear lint           # Biome check src/
bun run --cwd plugins/plugin-facewear test           # vitest (builds views + emulator first)
bun run --cwd plugins/plugin-facewear emulator:build # build emulator only
bun run --cwd plugins/plugin-facewear emulator:cli   # run emulator CLI
bun run --cwd plugins/plugin-facewear verify:app     # registry + plugin-registration integration tests
```

## Config / env vars

All settings are optional. The plugin reads them via `runtime.getSetting()` (falls back to `process.env`).

| Setting / env var | Default | Description |
|-------------------|---------|-------------|
| `FACEWEAR_WS_PORT` | `31338` | WebSocket port for XR streaming (Quest 3, XReal, Vision Pro) |
| `FACEWEAR_SMARTGLASSES_TRANSPORT` | `"auto"` | Even Realities transport: `auto` \| `even-bridge` \| `web-bluetooth` \| `noble` |
| `FACEWEAR_SCAN_TIMEOUT_MS` | `10000` | BLE scan timeout in ms (Noble transport) |
| `FACEWEAR_AUTO_INIT` | `true` | Send G1 connection-ready init packets automatically |
| `FACEWEAR_INIT_MODE` | `"lens-specific"` | G1 init mode: `lens-specific` \| `official` \| `android-f4` |
| `XR_APP_URL` | local IP | Override the URL shown on the `/xr/connect` pairing page |
| `XR_WS_PORT` | `31338` | Alias for `FACEWEAR_WS_PORT` read by `XRSessionService` |

Legacy aliases `SMARTGLASSES_TRANSPORT`, `SMARTGLASSES_SCAN_TIMEOUT_MS`, `SMARTGLASSES_AUTO_INIT`, `SMARTGLASSES_INIT_MODE` are still read and mapped to the `FACEWEAR_*` settings.

## How to extend

### Add an action
1. Create `src/actions/my-action.ts`, export an `Action` object.
2. Import and add it to the `actions` array in `src/index.ts`.
3. If it targets `SmartglassesService`, gate `validate` with `Boolean(getSmartglassesService(runtime))`.
4. If it targets `XRSessionService`, gate with `runtime.getService<XRSessionService>(XR_SERVICE_TYPE)`.

### Add a provider
1. Create `src/providers/my-provider.ts`, export a `Provider` object.
2. Import and add it to the `providers` array in `src/index.ts`.

### Add a service
1. Extend `Service` from `@elizaos/core`, implement `static start()` and `stop()`.
2. Add to the `services` array in `src/index.ts`.
3. Export from `src/index.ts` for consumers.

### Add a route
1. Create or extend a file in `src/routes/`, export a `Route` object.
2. Add to the `routes` array in `src/index.ts`.

### Add a device profile
1. Create `src/devices/my-device.ts` following the pattern in `meta-quest.ts`.
2. Register it in `src/devices/registry.ts` (`DEVICE_REGISTRY` and `FacewearDeviceType`).

## Conventions / gotchas

- **`@abandonware/noble` is an optional dep.** It is unavailable in browser contexts and on some CI runners. `NobleG1Transport` must never be imported unconditionally at module load — it is always required lazily inside `SmartglassesService.start()`.
- **Transport auto-selection order:** `even-bridge` → `web-bluetooth` → `noble`. Set `FACEWEAR_SMARTGLASSES_TRANSPORT` to force one.
- **View bundles** (`build:views`) must be built before `test` — the test script runs `build:views && emulator:build` before vitest.
- **`emulator/`** is a separate Bun workspace. `emulator:build` runs `bun install --force` inside it.
- **`app-xr/`** is the WebXR browser client deployed to headsets. It is built separately and served via the view-host route.
- **Backward-compat aliases**: `smartglassesPlugin`, `smartglassesControlAction`, `smartglassesStatusAction`, `displaySmartglassesTextAction`, `smartglassesMicrophoneAction` are all re-exported from `src/index.ts` pointing at the same objects.
- **`XR_WS_PORT_DEFAULT = 31338`** is exported from `xr-session-service.ts` and must stay in sync with the `FACEWEAR_WS_PORT` default in `agentConfig`.
- See `docs/smartglasses.md` for the full Even Realities G1 protocol reference and hardware proof workflow.
