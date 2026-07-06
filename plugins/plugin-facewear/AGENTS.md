# @elizaos/plugin-facewear

Unified facewear plugin for elizaOS — adds XR headset streaming and BLE smartglasses control to any Eliza agent.

## Purpose / role

Registered as `@elizaos/plugin-facewear` (opt-in, category `hardware`). Connects Eliza agents to Meta Quest 3, XReal, Apple Vision Pro (WebXR over WebSocket), and Even Realities G1/G2 smartglasses (BLE via Noble, Web Bluetooth, or a native bridge). Provides bidirectional voice + camera streaming for XR headsets, a full G1 display/control protocol for smartglasses, and in-app view panels for device management.

**This is the single home for VR/AR/smartglasses + their setup** — device pairing, native app SDKs (`scripts/setup-sdks.mjs`), and the desktop **OpenXR runtime** detector/installer (`src/runtime/`) all live here. `@elizaos/plugin-xr` is superseded by this plugin. The immersive renderer itself (WebXR session + DOM→texture panels) lives in `@elizaos/ui/spatial` (`enterImmersiveScene` / `enterImmersiveFromSpecs`); facewear owns the device + runtime **setup** that makes it reachable.

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
| `SETUP_XR_RUNTIME` (`facewearSetupRuntimeAction`) | `actions/xr-runtime-setup.ts` | Detect the desktop OpenXR runtime (Monado/SteamVR/WMR) + show install steps |

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
| `GET /api/facewear/xr-runtime` | `routes/xr-runtime.ts` | Desktop OpenXR runtime status + install plan (drives the FacewearView "vr/ar runtime" row) |
| simulator route | `routes/simulator-route.ts` | Simulator UI host |
| view-host route | `routes/view-host.ts` | Serve in-headset view bundles |
| views route | `routes/views.ts` | View catalog endpoint |

### Views
The **GUI config lives in Settings → Wearables**, not the top-level launcher.
`register.ts` registers one combined `wearables` settings section
(`WearablesSettingsSection`, group `system`) with two internal tabs:
`FacewearView` (XR headset manager) and `SmartglassesView` (Even Realities
pairing + diagnostics). The `facewear`/`smartglasses` view declarations in
`index.ts` remain (`visibleInManager:false`, `desktopTabEnabled:false`,
modalities `xr`/`tui`) only so the agent keeps serving the in-headset XR view
host and terminal (TUI) surfaces, and `FACEWEAR_*`/`SMARTGLASSES_*`/`XR_*`
actions still resolve. Do **not** re-add a `gui` modality or `app.navTabs` for
these — wearable hardware is configuration.

## Layout

```
src/
  index.ts                    Plugin object + all exports
  register.ts                 Secondary entry for view-only imports
  register-terminal-view.tsx  Terminal (TUI) view registration
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
  components/
    SmartglassesSpatialView.tsx   Spatial view component for smartglasses
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
    registry.ts               DEVICE_REGISTRY — 5 profiles (meta-quest, xreal, even-realities, apple-vision-pro, simulator); simulator defined inline
    apple-vision-pro.ts / even-realities.ts / meta-quest.ts / xreal.ts
  protocol/
    smartglasses.ts           G1 binary protocol (encode* functions, event types)
    xr.ts                     XR WebSocket framing protocol
  transport/
    even-bridge.ts            EvenBridgeTransport — native Android/desktop bridge
    noble.ts                  NobleG1Transport — Node.js BLE via @abandonware/noble
    web-bluetooth.ts          WebBluetoothG1Transport — browser Web Bluetooth API
    mock.ts                   MockSmartglassesTransport — deterministic test transport
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
bun run --cwd plugins/plugin-facewear setup:sdks     # check native app SDKs + OpenXR runtime
bun run --cwd plugins/plugin-facewear setup:openxr   # install a desktop OpenXR runtime (no-root SteamVR where possible)
bun run --cwd plugins/plugin-facewear verify:app     # registry + plugin-registration integration tests
```

## Config / env vars

All settings are optional. The plugin reads them via `runtime.getSetting()` (falls back to `process.env`).

| Setting / env var | Default | Description |
|-------------------|---------|-------------|
| `XR_WS_PORT` | `31338` | WebSocket port for XR streaming (Quest 3, XReal, Vision Pro). Read by `XRSessionService` via `XR_WS_PORT_ENV`; default is `XR_WS_PORT_DEFAULT` |
| `FACEWEAR_SMARTGLASSES_TRANSPORT` | `"auto"` | Even Realities transport: `auto` \| `even-bridge` \| `web-bluetooth` \| `noble` |
| `FACEWEAR_SCAN_TIMEOUT_MS` | `10000` | BLE scan timeout in ms (Noble transport) |
| `FACEWEAR_AUTO_INIT` | `true` | Send G1 connection-ready init packets automatically |
| `FACEWEAR_INIT_MODE` | `"lens-specific"` | G1 init mode: `lens-specific` \| `official` \| `android-f4` |
| `XR_APP_URL` | local IP | Override the URL shown on the `/xr/connect` pairing page |
| `XR_AGENT_URL` | (none) | Override the agent API URL injected into view-host and view-actions |

`FACEWEAR_WS_PORT` is declared in `agentConfig.pluginParameters` (package.json) as the surfaced plugin parameter, but the runtime port is read from `XR_WS_PORT` — keep their defaults in sync.

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

- **`@abandonware/noble` is an optional dep.** It is unavailable in browser contexts and on some CI runners. The native module is never imported at module load — `getNobleG1Transport()` (called from `SmartglassesService` transport selection) loads it lazily via a dynamic import and returns `null` when it is missing.
- **Transport auto-selection order:** `even-bridge` → `web-bluetooth` → `noble`. Set `FACEWEAR_SMARTGLASSES_TRANSPORT` to force one.
- **View bundles** (`build:views`) must be built before `test` — the test script runs `build:views && emulator:build` before vitest.
- **`emulator/`** is a separate Bun workspace. `emulator:build` runs `bun install --force` inside it. Its **XR browser-harness** files (`emulator.ts`, `types.ts`, `playwright-fixture.ts`, `mock-agent.ts`) are now thin **re-exports of the canonical `@elizaos/plugin-xr` simulator** (#9941 — exactly one XR harness); do not fork them. `device-emulator.ts` + `cli.ts` (the facewear BLE/device emulator) stay local.
- **`app-xr/`** is the WebXR browser client deployed to headsets. It is built separately and served via the view-host route. Its e2e (`app-xr/e2e/`) drives the **real `view-host.ts` route** via `route-server.ts` (bun) — the deleted `view-server.mjs` mock no longer exists — and the **real IWER emulator** (`window.__XREmulator`) for `camera-pose.spec.ts`.
- **Backward-compat aliases**: `smartglassesPlugin`, `smartglassesControlAction`, `smartglassesStatusAction`, `displaySmartglassesTextAction`, `smartglassesMicrophoneAction` are all re-exported from `src/index.ts` pointing at the same objects.
- **`XR_WS_PORT_DEFAULT = 31338`** is exported from `xr-session-service.ts` and must stay in sync with the `FACEWEAR_WS_PORT` default in `agentConfig`.
- See `docs/smartglasses.md` for the full Even Realities G1 protocol reference and hardware proof workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
