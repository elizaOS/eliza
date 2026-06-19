# Eliza Facewear — Even Realities G1/G2 Companion App

Android companion app that bridges the Even Realities G1 (and G2) glasses to an
elizaOS agent via BLE.

## Architecture

```
elizaOS Agent (WebSocket)
        ↕  WebSocket (OkHttp)
AgentBridgeService (Android)
        ↕  Android Binder IPC
G1BleService (Android)
        ↕  BLE GATT / Nordic UART Service
Even Realities G1 glasses
```

The G1 runs its own ARM firmware and communicates over BLE. This app uses the
Nordic UART Service (NUS) BLE profile (UUID
`6e400001-b5a3-f393-e0a9-e50e24dcca9e`) exposed by both lenses and does not
consider pairing ready until the left and right lens are connected.

## BLE Protocol

The G1 implements the same core command framing used by `plugin-facewear`:

| Command byte | Payload | Action |
|---|---|---|
| `0x4E` | display sequence/chunk header + UTF-8 text | Display text on both lenses |
| `0xF5 0x18` | stop subcommand | Clear display |
| `0x01` | level + auto flag | Set display brightness |
| `0x0E` | `0x01` / `0x00` | Enable / disable the right-lens mic |
| `0x25` | heartbeat sequence | Keep connection alive |
| `0x2C 0x01` | none | Request battery status |
| `0x4D 0x01` / `0xF4 0x01` | none | Left/right connection-ready init |

Incoming `0xF1` mic frames are forwarded to the agent as `mic_lc3` JSON events
with `sampleRate: 16000`, `encoding: "lc3"`, byte-array payloads, and base64
payloads. Other RX packets are forwarded as `g1_raw` events so the agent can
parse taps, serial responses, battery status, and display acknowledgements.

## Prerequisites

| Tool | Version |
|------|---------|
| Android Studio | Hedgehog 2023.1+ |
| JDK | 17 |
| Android SDK API | 35 |
| Android device | API 29+ with Bluetooth LE |

## Building

```bash
./gradlew assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```

## Installing

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Usage

1. Enable Bluetooth on your Android phone
2. Turn on your G1 glasses
3. Open the app → tap **Scan for G1**
4. The app will find `_L_` and `_R_` G1 lenses via BLE and connect both
5. Enter your elizaOS agent WebSocket URL (e.g. `ws://192.168.1.100:31337/xr-ws`)
6. Tap **Connect to Agent**
7. Agent responses will appear on the G1 HUD display

## How the Agent Integration Works

- `AgentBridgeService` connects to the elizaOS WebSocket and sends a `hello` frame with `deviceType: "even-realities"`
- The agent (plugin-facewear) should detect this device type and skip TTS audio (G1 has no speaker)
- `agent_text` frames are forwarded to `G1BleService.displayText()` → BLE → both G1 HUD lenses
- `transcript` frames (final=true) show "You: ..." on the HUD
- `clear_display`, `mic_control`, `brightness`, `battery_status`, `heartbeat`,
  and `g1_write` agent frames are forwarded to the BLE service
- G1 RX packets are forwarded back to the agent as `g1_raw`; `0xF1` microphone
  chunks are additionally forwarded as `mic_lc3`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Scan finds nothing | G1 not powered on, or pairing mode not active |
| `GATT_ERROR 133` | Common on first connect — retry once or power-cycle G1 |
| NUS service not found | Wrong device or firmware too old |
| Text not showing on G1 | Confirm both lenses report ready and the agent is sending `agent_text` frames |
| WebSocket refused | Check agent is running; use LAN IP, not localhost |
| Permission denied on BLE scan | Grant Location + Bluetooth permissions in Settings |
