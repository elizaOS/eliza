# @elizaos/plugin-facewear

Even Realities G1/G2 smartglasses integration for ElizaOS.

## Implemented Surfaces

- View Manager page at `/apps/smartglasses` for whole-headset pairing,
  diagnostics, platform setup guidance, report export, and bridge-backed Wi-Fi
  scan/configuration/setup prompts when a native bridge exposes those APIs.
  The page uses a native Even/Mentra bridge when present for iOS/Android-style
  hosts and falls back to direct Web Bluetooth for desktop browsers.
- G1 UART protocol constants for Nordic UART service:
  - service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
  - TX `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
  - RX `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`
- Display text streaming with G1 `0x4E` packets, five-line page wrapping using the hardware-derived G1 glyph width profile, official 191-byte payload chunking, Even AI in-progress/completion status (`0x31`/`0x40`), and direct Text Show status (`0x71`).
- RSVP word-group display using the same wrapped G1 display path for rapid reading-style presentation.
- Microphone open/close with G1 `0x0E` packets and right-lens mic routing.
- Direct G1 `0xF1` mic data is exposed as raw LC3 audio (`audioData`, `audioEncoding: "lc3"`) with packet sequence tracking and gap counts. A native/platform LC3 decoder can be injected with `setAudioDecoder` or `setSmartglassesAudioDecoderForRuntime` to convert those chunks into PCM16 for `onAudio` callbacks. EvenHub/G2 bridge `audioEvent.audioPcm` data and MentraOS `mic_pcm` events are exposed as 16 kHz PCM16 and converted to float samples automatically; MentraOS `mic_lc3` events are preserved as LC3.
- MentraOS/G2 `local_transcription` and `transcription:*` bridge events are normalized into `SMARTGLASSES_TRANSCRIPT` runtime events and `onTranscript` callbacks, so host STT output from the glasses microphone reaches Eliza.
- Side tap handling:
  - single tap enables mic
  - double tap disables mic
  - long press / Even AI activation (`0xF5 0x17`) enables mic
  - Even AI recording stop (`0xF5 0x18`) disables mic
- EvenHub simulator click/double-click events are normalized to the same tap labels, so simulator input exercises the same microphone toggle path.
- EvenHub/G2 scroll-up and scroll-down events are normalized and routed to the same manual page controls as direct G1 page-up/page-down.
- Incoming hardware event parsing for interaction, physical, battery, device, init, display-result, notification, dashboard, serial-number response, heartbeat, mic response, mic data, response, and error categories.
- Runtime events:
  - `SMARTGLASSES_EVENT`
  - `SMARTGLASSES_AUDIO`
  - `SMARTGLASSES_TRANSCRIPT`
- Managed heartbeat loop for G1 connection maintenance, matching the upstream SDK pattern of periodic `0x25` packets.
- G1 controls:
  - clear display
  - start AI, connection-ready init (`0x4D 0x01` left / `0xF4 0x01` right by default, official EvenDemoApp iOS same-init `0x4D 0x01` to both lenses, or EvenDemoApp Android `0xF4 0x01` to both lenses), exit to dashboard, native function exit (`0x18`), serial request/response (`0x34`), app whitelist (`0x04`), raw packet writes, one-shot heartbeat, and managed heartbeat start/stop
  - manual-mode page up/down (`0xF5 0x01`, left for page-up and right for page-down)
  - silent mode
  - brightness
  - dashboard show/hide and position
  - dashboard layout, calendar item, time/weather, and setup payload packets from the Fahrplan G1 dashboard model
  - navigation init, direction text, primary/secondary image, poller, and end packets
  - translation setup/start/language/original/translated text overlay packets
  - head-up angle
  - wear detection
  - notes add/delete
  - QuickNote voice-note list parsing plus voice-note audio fetch/delete subcommands
  - notifications, including notification ID packet headers
  - 1-bit BMP generation/transfer framing with CRC for native `576x136` image payloads
- Dual-lens writes are serialized left-then-right for commands that target both lenses, matching the native G1 guidance. Microphone activation remains right-lens only.
- Transports:
  - `EvenBridgeTransport` for EvenHub/G2-style bridge hosts, including simulator-style `sendStartUpPage`, `onEvenHubEvent`, and `audioControl`, plus MentraOS Bluetooth SDK `displayText`, `clearDisplay`, `setMicState`, `mic_pcm`, `mic_lc3`, and local transcription events
  - `WebBluetoothG1Transport` for direct browser BLE
  - `NobleG1Transport` for optional Node/Bun BLE through `@abandonware/noble`
  - `MockSmartglassesTransport` for tests and examples

Direct G1 BLE does not expose a verified Wi-Fi provisioning command in the
reviewed upstreams. Wi-Fi scan/configuration is therefore available only through
native/bridge APIs such as Mentra/ASG bridge surfaces.

## Eliza Actions

- `SMARTGLASSES_DISPLAY_TEXT`
- `SMARTGLASSES_MICROPHONE`
- `SMARTGLASSES_CONTROL`
- `SMARTGLASSES_STATUS`

`SMARTGLASSES_DISPLAY_TEXT` accepts plain text or JSON:

```json
{ "text": "Show this on the glasses", "mode": "text" }
```

Use `mode: "ai"` for the default Even AI streaming/completion display path or
`mode: "text"` for the direct Text Show path documented by EvenDemoApp. JSON
input can also include `pageHoldMs` between pages and `completionDelayMs`
before sending the final completion frame:

```json
{ "text": "Paced multi-page display", "mode": "ai", "pageHoldMs": 1200, "completionDelayMs": 250 }
```

`SMARTGLASSES_CONTROL` accepts JSON such as:

```json
{ "op": "brightness", "level": 10, "auto": true }
```

Supported `op` values: `connect`, `disconnect`, `clear`, `exit_dashboard`, `exit_function`, `start_ai`, `connection_ready`, `page_up`, `page_down`, `rsvp_text`, `heartbeat`, `heartbeat_start`, `heartbeat_stop`, `raw`, `get_serial`, `app_whitelist`, `g1_setup`, `silent_mode`, `brightness`, `wifi_scan`, `wifi_status`, `wifi_configure`, `wifi_setup`, `dashboard`, `dashboard_layout`, `dashboard_calendar`, `dashboard_time_weather`, `headup_angle`, `wear_detection`, `navigation_start`, `navigation_directions`, `navigation_primary_image`, `navigation_secondary_image`, `navigation_poller`, `navigation_end`, `translate_setup`, `translate_start`, `translate_languages`, `translate_original`, `translate_translated`, `note_add`, `note_delete`, `voice_note_fetch`, `voice_note_delete`, `notification`, `bmp_image`.

`connect` pairs or reconnects the whole headset through the configured
transport and sends connection-ready init packets by default. Aliases include
`pair`, `pair_headset`, and `connect_headset`. Pass `init: false` to reconnect
without sending init packets:

```json
{ "op": "connect", "init": false }
```

`disconnect` closes the active headset transport. Aliases include `unpair` and
`disconnect_headset`.

Bridge-backed Wi-Fi actions are available only when the active transport
exposes native phone/headset setup APIs:

```json
{ "op": "wifi_scan" }
```

```json
{ "op": "wifi_configure", "ssid": "Home Wi-Fi", "password": "secret" }
```

Mentra-style SDK hosts can expose a native setup prompt instead of direct
credential APIs:

```json
{ "op": "wifi_setup", "reason": "Eliza needs headset Wi-Fi" }
```

`heartbeat_start` accepts optional `intervalMs` and `immediate` fields. By
default it sends a heartbeat immediately and then every 8 seconds until
`heartbeat_stop`, service disconnect, or service stop.

`rsvp_text` accepts `text`, optional `wordsPerGroup`, `wpm`, `paddingChar`,
`mode`, and `skipDelay`. It mirrors the RSVP display pattern from the Python
examples while still using the plugin's normal display packet encoder:

```json
{ "op": "rsvp_text", "text": "Rapid serial visual presentation", "wordsPerGroup": 2, "wpm": 250 }
```

`raw` accepts `data`, `bytes`, `hex`, or `base64` plus optional `side`/`target`
(`left`, `right`, or `both`). This keeps low-level SDK commands such as native
connection-ready packets reachable while `connection_ready` covers the common
left/right initialization pair directly. Pass `initMode: "official"` to send
the EvenDemoApp iOS same-init form (`0x4D 0x01`) to both lenses, or
`initMode: "android-f4"` to send the EvenDemoApp Android form (`0xF4 0x01`) to
both lenses:

```json
{ "op": "connection_ready", "initMode": "official" }
```

`bmp_image` accepts prebuilt BMP bytes through `hex`, `base64`, or `data`.
It can also generate a native 1-bit BMP from grayscale pixels:

```json
{ "op": "bmp_image", "pixels": [0, 255, 255, 0], "width": 2, "height": 2 }
```

Dashboard/navigation/translation operations expose the packet families used by
Fahrplan in addition to plain text display:

```json
{ "op": "dashboard_calendar", "name": "Standup", "time": "13:30-14:30", "location": "Lab" }
```

```json
{ "op": "navigation_directions", "totalDuration": "4 min", "totalDistance": "1 km", "direction": "Main St", "distance": "200 m", "speed": "30", "directionTurn": 3 }
```

Navigation image operations accept `image` as an array, hex, or base64 bit
plane. `overlay` uses the same formats and defaults to an all-zero overlay when
omitted, which keeps secondary navigation image action payloads compact enough
for Eliza JSON extraction:

```json
{ "op": "navigation_secondary_image", "image": "<base64 bit plane>" }
```

```json
{ "op": "translate_translated", "text": "bonjour", "syncId": 3 }
```

## Configuration

- `SMARTGLASSES_TRANSPORT`: `auto` (default), `even-bridge`, `web-bluetooth`, or `noble`.
- `SMARTGLASSES_SCAN_TIMEOUT_MS`: optional Noble BLE scan timeout in milliseconds.
- `SMARTGLASSES_AUTO_INIT`: send left/right initialization packets after Eliza-managed startup. Defaults to `true`.
- `SMARTGLASSES_INIT_MODE`: `lens-specific` (default) sends `0x4D 0x01` to the left lens and `0xF4 0x01` to the right lens; `official` sends `0x4D 0x01` to both lenses as in EvenDemoApp iOS; `android-f4` sends `0xF4 0x01` to both lenses as in EvenDemoApp Android.

## Microphone Audio

EvenHub/G2 bridge hosts and the EvenHub simulator deliver `audioEvent.audioPcm`
as signed 16 kHz PCM16, which the service converts to `Float32Array` samples for
`onAudio`. MentraOS Bluetooth SDK bridge hosts can also deliver `mic_pcm` events
with signed 16 kHz PCM16, or `mic_lc3` events that flow through the same LC3
decoder hook as direct G1 packets.

Direct G1 hardware sends `0xF1` packets containing LC3 frames. The upstream
Android/iOS examples decode those frames with platform-native LC3 code, so this
package preserves raw LC3 by default and exposes a decoder hook for host apps
that have a native or WASM LC3 decoder:

```ts
service.setAudioDecoder(async (audio, context) => {
  if (context.encoding !== "lc3") return null;
  return decodeLc3ToPcm16(audio);
});
```

For plugin-managed startup, register the same hook before the service starts:

```ts
setSmartglassesAudioDecoderForRuntime(decodeLc3ToPcm16);
```

## Upstream Evidence

The implementation was derived from the ignored research checkouts in
`research/even-realities/`. The reviewed sources and resulting implementation
choices are:

See `docs/upstream-audit.md` for the full source-to-implementation audit with
local file references and test coverage.

| Source | Relevant findings applied here |
| --- | --- |
| `fabioglimb/even-toolkit` | EvenHub/G2 bridge audio uses `rawBridge.audioControl` or `callEvenApp("audioControl", { isOpen })`; PCM arrives as `event.audioEvent.audioPcm` at 16 kHz. |
| `BxNxM/even-dev` | Simulator apps use `waitForEvenAppBridge`, `onEvenHubEvent`, `sendStartUpPage`, `createStartUpPageContainer`, `rebuildPageContainer`, click/double-click event codes, and the `@evenrealities/evenhub-simulator` automation/audio model. |
| `emingenc/even_glasses` | G1 command models for `0x4E` display, RSVP word-group display, `0x0E` mic control, `0x25` heartbeat, settings, notes, notifications, BMP transfer, and incoming notification handlers for init/display/notification events; BLE discovery identifies lenses by `_L_` and `_R_`. |
| `binarythinktank/eveng1_python_sdk` | Nordic UART UUIDs, heartbeat packet `[0x25, 0x06, 0x00, seq, 0x04, seq]`, managed heartbeat loop for connection health, display packet header shape, mic response semantics, LC3 mic chunks, and broad BLE scan followed by left/right name matching. |
| `meyskens/fahrplan` | Confirms practical G1 app surfaces: notification mirroring, dashboard/checklist style display, dashboard calendar/time-weather/setup packet families, navigation mode packets, translation overlay packets, QuickNote/voice-note `0x21` metadata, `0x1E` voice-note audio fetch/delete subcommands, and live transcription using the glasses microphone; Linux BLE caveats informed the explicit hardware smoke paths. |
| `nickustinov/weather-even-g2` | G2 app event handling treats captured `listEvent`, `textEvent`, and `sysEvent` payloads as click/scroll sources and handles missing zero-value list indices from protobuf. |
| `jappyjan/even-realities` | EvenHub SDK wrapper patterns for startup/rebuild page containers and event listener registration. |
| `emingenc/g1_flutter_blue_plus` | Flutter BLE connection flow scans broadly, matches `_L_`/`_R_`, then discovers the Nordic UART service and TX/RX characteristics. |
| `nickustinov/tesla-even-g2` | G2 bridge event normalization for nested `eventType`, `event_type`, `Event_Type`, click/double-click/scroll codes, and captured-event fallback to click. |
| `galfaroth/awesome-even-realities-g1` | Cross-check index for the G1 ecosystem and the Python wrapper sources used above. |
| `even-realities/EvenDemoApp` | Official demo evidence for mic on the right lens, `0xF1` LC3 mic packet shape, text streaming, notification flows, native function exit, serial request, app whitelist packetization, connection-ready same-init packets (`0x4D 0x01` to both lenses), and BMP data/end/CRC framing. |
| `Mentra-Community/MentraOS` | Architecture context for smartglasses apps as BLE-to-phone/cloud pipelines, native bridge display APIs (`displayText`, `clearDisplay`), `setMicState`, `mic_pcm`/`mic_lc3` event streams, `local_transcription`/`transcription:*` events, G1 glyph-width display profile for pixel-aware wrapping, display bandwidth limits, and hardware-dependent verification requirements. |

The implementation intentionally separates direct G1 BLE transports from the EvenHub/G2 bridge transport because the upstream projects expose those as different runtime surfaces.

## Verification

```bash
bun run --cwd plugins/plugin-facewear lint
bun run --cwd plugins/plugin-facewear typecheck
bun run --cwd plugins/plugin-facewear test
bun run --cwd plugins/plugin-facewear build
bun run --cwd packages/examples/smartglasses test
bun run --cwd packages/examples/smartglasses start
bun run --cwd packages/examples/smartglasses smoke:package
bun run --cwd packages/examples/smartglasses smoke:simulator
bun run --cwd packages/examples/smartglasses typecheck
bun run --cwd packages/examples/smartglasses verify:software
bun run --cwd packages/examples/smartglasses hardware:status-latest
```

## Hardware Smoke

The browser hardware smoke example exercises the direct G1 BLE path:

```bash
bun run --cwd packages/examples/smartglasses dev:hardware
```

Open `http://127.0.0.1:5178/hardware-smoke.html` in a Web Bluetooth-capable
browser. Use **Connect Headset** for the two-step whole-headset flow; the same
button prompts for the left lens and then the right lens because browsers
require a user gesture for each Bluetooth picker. The page sends
connection-ready/init, serial request, display, mic, brightness, dashboard,
head-up angle, and wear-detection commands, then logs a structured evidence
checklist for single-tap mic enable, double-tap mic disable, LC3 audio
notifications, serial responses, packet writes, and final service status.

The EvenHub simulator can exercise the G2 bridge surface without physical hardware:

```bash
bun run --cwd packages/examples/smartglasses dev:simulator
bun run --cwd packages/examples/smartglasses simulator
```

An automated simulator smoke harness is also available:

```bash
bun run --cwd packages/examples/smartglasses smoke:simulator
```

The simulator currently publishes 16 kHz signed PCM audio events through the EvenHub bridge. It is useful for bridge display, input, audio-control, and automation checks, but it is not a replacement for physical G1/G2 validation.

To exercise simulator microphone delivery, pass an EvenHub simulator audio
input ID. The automated smoke will forward it as `--aid`, click to enable the
bridge microphone, and wait for an `audioEvent.audioPcm` event:

```bash
SMARTGLASSES_SIMULATOR_AUDIO_DEVICE="coreaudio:BuiltInMicrophoneDevice" bun run --cwd packages/examples/smartglasses smoke:simulator
```

The Node/Bun hardware smoke exercises the Noble transport:

```bash
bun run --cwd packages/examples/smartglasses hardware:noble
```

It scans for left/right lenses, connects to the UART service, sends
connection-ready/init, serial request, display, and settings packets, disables
the right microphone, waits for a `wearing` physical state, then requires a
single tap to enable microphone capture, speech audio, and a double tap to
disable capture during the smoke window. The glasses must be out of the
charging cradle and worn for tap and microphone evidence.
`SMARTGLASSES_SCAN_TIMEOUT_MS`, `SMARTGLASSES_HOLD_MS`,
`SMARTGLASSES_WEARING_TIMEOUT_MS=30000`,
`SMARTGLASSES_INIT_MODE=official|lens-specific|android-f4`, and
`SMARTGLASSES_DIRECT_MIC_MS=15000` can tune scan, microphone wait time, wearing
wait, init variant, and direct mic diagnostics. Set
`SMARTGLASSES_REPORT_PATH=./smartglasses-hardware-report.json` to write a
structured evidence artifact covering packet writes, serial state, headset
physical/battery/device state, side-tap mic state, audio chunks, and final
service status.

For the final auditable hardware proof run, use the bundled latest-report
helpers. They write `/tmp/smartglasses-hardware-report-latest.json`, print a
setup/status summary even when the smoke fails, and then run the strict
validator:

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:noble
```

If the short proof run connects both lenses but never observes worn state, run
the watch proof wrapper. It waits longer while preserving the same
latest-report, status, and freshness-validation flow:

If the status summary reports `physicalBlocker: "headset_not_found"`, the scan
did not discover either lens. Remove both lenses from the charging base, keep
them near this device, and rerun the watch proof. Failed Bleak reports include
`discoveredDevices`, `discoveredDeviceCount`, and `discoveredG1DeviceCount` to
show whether CoreBluetooth saw nearby BLE devices but no Even/G1 lenses.
If Noble reports `physicalBlocker: "transport_unavailable"` on macOS, the
native Noble binding is not usable for this runtime; use the Bleak/CoreBluetooth
proof or rebuild `@abandonware/noble` for the current Node/Bun ABI.

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:noble:watch
```

Inspect and validate that latest artifact independently before treating
physical hardware support as proven. The latest validator requires the `/tmp`
report to be fresh within ten minutes; use `hardware:validate-report <path>`
for historical artifacts:

```bash
bun run --cwd packages/examples/smartglasses hardware:status-latest
bun run --cwd packages/examples/smartglasses hardware:validate-latest
```

A passing report must show real lens connection, connection-ready/init writes,
display packet writes, serial request and observed serial response, settings
writes, observed tap events, single-tap microphone enable, double-tap
microphone disable, non-empty microphone audio, and final connected service
status with serial and audio counters. Simulator and mock tests are useful
regression coverage, but they do not satisfy this physical hardware gate. The
validator reports `headsetInCradle` and `wearingStateNotObserved` separately
when the setup state explains missing tap or microphone evidence.

To validate a custom report path instead of the latest helper output:

```bash
bun run --cwd packages/examples/smartglasses hardware:validate-report ./smartglasses-hardware-report.json
```
