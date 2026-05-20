# Smartglasses Upstream Audit

This plugin was built from the gitignored research checkouts under
`research/even-realities/`. The repository root `.gitignore` ignores that
checkout folder, so these upstream repos remain local evidence and are not part
of the committed package.

## Repository Coverage

| Requested source | Local checkout | Primary files reviewed | Capability carried into `@elizaos/plugin-hearwear` |
| --- | --- | --- | --- |
| `fabioglimb/even-toolkit` | `research/even-realities/even-toolkit` | `glasses/bridge.ts`, `glasses/glass-format.ts`, `glasses/paginate-text.ts`, `glasses/gestures.ts`, `stt/sources/glass-bridge.ts`, `stt/audio/pcm-utils.ts` | G2/EvenHub bridge display, event, and PCM audio assumptions; text pagination and gesture normalization informed `src/transport/even-bridge.ts` and `src/protocol/smartglasses.ts`. |
| `BxNxM/even-dev` | `research/even-realities/even-dev` | `apps/_shared/even-events.ts`, `apps/_shared/autoconnect.ts`, `apps/base_app/src/base-template.ts`, `README.md` | Simulator bridge lifecycle, `sendStartUpPage`, app bridge readiness, and click/double-click input expectations used by `packages/examples/smartglasses/evenhub-smoke.ts` and `simulator-automation-smoke.ts`. |
| `emingenc/even_glasses` | `research/even-realities/even_glasses` | `even_glasses/models.py`, `even_glasses/utils.py`, `even_glasses/commands.py`, `even_glasses/notification_handlers.py`, `even_glasses/bluetooth_manager.py`, `even_glasses/README.md` | G1 command constants, display packet framing, RSVP, mic control, mic response parsing, LC3 notification parsing, heartbeat, dashboard/settings, BMP, and notification handling in `src/protocol/smartglasses.ts` and `src/services/smartglasses-service.ts`. |
| `binarythinktank/eveng1_python_sdk` | `research/even-realities/eveng1_python_sdk` | `connector/bluetooth_manager.py`, `services/commands.py`, `services/notification_handlers.py`, `utils/message_utils.py`, `examples/*.py` | Nordic UART UUIDs, broad scan plus `_L_`/`_R_` lens matching, heartbeat bytes, LC3 mic chunks, and display packet shape used by `src/transport/noble.ts`, `src/transport/web-bluetooth.ts`, and protocol tests. |
| `meyskens/fahrplan` | `research/even-realities/fahrplan` | `lib/bluetooth_manager.dart`, `lib/services/*`, `lib/features/*`, `README.md` | Practical G1 app coverage for dashboard/checklist display, notification mirroring, navigation, translation, QuickNote/voice-note list/fetch/delete/delete-all packets, and live transcription expectations reflected in `src/actions/facewear-control.ts`, `src/protocol/smartglasses.ts`, and package smoke coverage. |
| `nickustinov/weather-even-g2` | `research/even-realities/weather-even-g2` | `g2/index.ts`, `g2/events.ts`, `g2/ui.tsx`, `_shared/*`, `README.md` | G2 captured-event behavior, list/text/system event handling, and zero-value index edge cases used by EvenHub event normalization. |
| `jappyjan/even-realities` | `research/even-realities/even-realities` | `packages/*`, `apps/*`, SDK/app examples | EvenHub SDK wrapper patterns for page startup, rebuild, and listener registration used by `EvenBridgeTransport`. |
| `emingenc/g1_flutter_blue_plus` | `research/even-realities/g1_flutter_blue_plus` | `lib/services/commands.dart`, `lib/services/reciever.dart`, `lib/services/bluetooth_manager.dart`, `lib/main.dart` | Flutter BLE discovery and direct G1 receiver behavior cross-checked command constants, `_L_`/`_R_` pairing, `0xF5` taps, `0x0E` mic responses, and `0xF1` voice data. |
| `nickustinov/tesla-even-g2` | `research/even-realities/tesla-even-g2` | `g2/events.ts`, `g2/renderer.ts`, `g2/navigation.ts`, `g2/ui.tsx`, `README.md` | G2 bridge event normalization for nested event keys, click/double-click/scroll fallback, and dashboard/menu rendering expectations used by `src/transport/even-bridge.ts` and simulator smoke. |
| `galfaroth/awesome-even-realities-g1` | `research/even-realities/awesome-even-realities-g1` | `README.md` | Ecosystem cross-check for the G1 SDK/demo sources and command families. |
| `even-realities/EvenDemoApp` | `research/even-realities/EvenDemoApp` | `lib/ble_manager.dart`, `lib/services/ble.dart`, `lib/services/evenai.dart`, `lib/services/features_services.dart`, `lib/controllers/bmp_update_manager.dart`, `ios/Runner/BluetoothManager.swift`, `android/app/src/main/kotlin/com/example/demo_ai_even/bluetooth/BleManager.kt` | Official demo behavior for right-lens mic, LC3 audio, text streaming, native exit, serial request, app whitelist, iOS same-init (`0x4D 0x01` to both lenses), Android same-init (`0xF4 0x01` to both lenses), notification flows, and BMP transfer. |
| `Mentra-Community/MentraOS` | `research/even-realities/MentraOS` | `cloud/docs/sdk/display-layouts.mdx`, `cloud/docs/cloud-architecture/managers/audio-manager.mdx`, `cloud/docs/cloud-architecture/managers/microphone-manager.mdx`, `cloud/docs/cloud-architecture/managers/transcription-manager.mdx`, `sdk/*`, `mobile/*` | Bridge/native display APIs, `setMicState`, `mic_pcm`/`mic_lc3`, local transcription streams, display width/glyph constraints, G1 dashboard height/depth position packets, `0x2C 0x01` battery status request/response parsing, and hardware validation requirements used by `src/transport/even-bridge.ts`, display wrapping, transcript events, dashboard position controls, battery status, and hardware smoke evidence. |

## Implemented Surface

The upstream review maps to the following local implementation:

- Direct G1 BLE packet protocol and parsing: `src/protocol/smartglasses.ts`
- Eliza service lifecycle, display streaming, mic control, tap handling,
  audio/transcript events, heartbeat, and settings: `src/services/smartglasses-service.ts`
- Eliza actions/providers: `src/actions/*.ts`,
  `src/providers/smartglasses-status.ts`
- Direct BLE transports: `src/transport/web-bluetooth.ts`, `src/transport/noble.ts`
- EvenHub/G2/Mentra bridge transport: `src/transport/even-bridge.ts`
- Mock transport for deterministic Eliza tests: `src/transport/mock.ts`
- Physical validation harnesses:
  - `packages/examples/smartglasses/hardware-smoke.ts`
  - `packages/examples/smartglasses/noble-hardware-smoke.ts`
  - `packages/examples/smartglasses/hardware-evidence.ts`
- Simulator validation harness:
  - `packages/examples/smartglasses/evenhub-smoke.ts`
  - `packages/examples/smartglasses/simulator-automation-smoke.ts`

## Test Coverage

The implementation is covered by:

- `src/__tests__/protocol-smartglasses.test.ts`: packet encoding, pixel-aware display
  wrapping, display chunking, mic commands, tap/audio/serial parsing, settings,
  dashboard position/content, navigation, translation, notifications, notes, voice-note
  list/fetch/delete/delete-all, BMP, heartbeat, init modes, and app whitelist/setup.
- `src/__tests__/facewear-service.test.ts`: Eliza service display streaming, RSVP,
  sequence counters, mic toggle state, side tap behavior, long press/stop
  recording, raw and decoded audio paths, transcript events, startup auto-init,
  heartbeat loop, pre-connected transport listener attachment, and transport
  preference.
- `src/__tests__/functional-parity.test.ts`: exported action/provider/service wiring.
- `src/__tests__/even-bridge.test.ts`: G2/EvenHub/Mentra bridge rendering,
  audio, transcription, and input normalization.
- `src/__tests__/web-bluetooth.test.ts` and `src/__tests__/noble.test.ts`:
  direct BLE lens pairing, UART subscription/write behavior, and notification
  parsing.
- `packages/examples/smartglasses/smartglasses.test.ts`: package example packet
  path plus physical evidence helper requirements.
- `packages/examples/smartglasses/package-smoke.ts`: public package export,
  Eliza event emission, status provider, and action path.

## Remaining Physical Gate

The code includes physical G1 validation paths and direct BLE smoke coverage.
An earlier report from `2026-05-20T06:38:56Z` reached both lenses on the
plugged-in headset and proved whole-headset direct BLE connectivity, serial
response, init/display/settings responses, heartbeats, and right-lens
mic-disable response for serial `S110LABC040019`. It did not complete the
physical gate because that run did not observe a physical-state packet with
`wearing`, so tap and microphone audio evidence could not be observed. The
freshest short Bleak attempt from `2026-05-20T07:42:31Z` did not discover
either lens. CoreBluetooth did discover 36 BLE devices, but zero matched
Even/G1 names and zero advertised the G1 UART service UUID. Both status and
validator output report
`physicalBlocker: "headset_not_found"` for that case, which means the next
Bleak attempt needs both lenses out of the charging base, nearby, advertising,
and worn before the tap/audio validation window. The Bleak raw report also
records `status.connected: false`, service UUID/manufacturer scan inventory,
and the same blocker-aware setup hint when no lenses are found. A Noble attempt from
`2026-05-20T07:26:42Z` failed before scanning because the native Noble BLE
binding is unavailable for the current macOS ARM64 Node/Bun ABI; that path now
writes a report and reports `physicalBlocker: "transport_unavailable"` instead
of silently leaving an older hardware report in place.

Use the root helpers for the next hardware proof attempt:

```bash
npm run smartglasses:hardware:prove:watch
npm run smartglasses:hardware:status
npm run smartglasses:hardware:validate
```

The lower-level package commands remain available when debugging inside the
example:

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak
bun run --cwd packages/examples/smartglasses hardware:status-latest
bun run --cwd packages/examples/smartglasses hardware:validate-latest
```

The Noble/Web Bluetooth paths are still available for adapter/browser-specific
checks:

```bash
npm run smartglasses:hardware:prove:noble
npm run smartglasses:dev:hardware
```

The required evidence checklist is enforced by
`packages/examples/smartglasses/hardware-evidence.ts`: connected lenses,
connection-ready/init writes, display packets, serial request and response,
settings writes, `wearing` physical state, single-tap mic enable, right-lens
mic-enable write, microphone audio, double-tap mic disable, and right-lens
mic-disable write.

The Bleak/CoreBluetooth proof report also captures macOS Bluetooth preflight
metadata (`bluetoothAdapter` and `pairedG1Devices`) before scanning. That keeps
the latest JSON artifact self-contained when diagnosing the paired-but-not-
advertising state that blocks the physical tap/audio gate.
