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

The G1 runs its own ARM firmware and communicates over BLE. There is no SDK or
official API — this app uses the Nordic UART Service (NUS) BLE profile
(UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`) which the G1 firmware exposes.

## BLE Protocol

The G1 implements a subset of the Even Realities proprietary command set over NUS:

| Command byte | Payload | Action |
|---|---|---|
| `0x4E` | UTF-8 text (≤ 250 bytes) | Display text on HUD |
| `0x06` | none | Clear display |
| `0x4B` | brightness byte (1–6) | Set display brightness |
| `0x26` | `0x01` / `0x00` | Enable / disable mic |

Note: Even Realities does not publish an official BLE spec. Command bytes above
are derived from community reverse-engineering. Verify against your firmware version.
Check https://github.com/even-realities/ for any official SDK releases.

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
4. The app will find the G1 via BLE and connect automatically
5. Enter your elizaOS agent WebSocket URL (e.g. `ws://192.168.1.100:31337/xr-ws`)
6. Tap **Connect to Agent**
7. Agent responses will appear on the G1 HUD display

## How the Agent Integration Works

- `AgentBridgeService` connects to the elizaOS WebSocket and sends a `hello` frame with `deviceType: "even-realities"`
- The agent (plugin-facewear) should detect this device type and skip TTS audio (G1 has no speaker)
- `agent_text` frames are forwarded to `G1BleService.displayText()` → BLE → G1 HUD
- `transcript` frames (final=true) show "You: ..." on the HUD

## Extending

To add mic input forwarding from G1 to agent:

1. In `G1BleService`, parse incoming BLE bytes on the NUS RX characteristic
2. Decode the mic audio format (PCM or compressed, firmware-dependent)
3. In `AgentBridgeService.forwardG1DataToAgent()`, encode as a binary frame:
   - 4-byte big-endian uint32 = JSON header length
   - JSON: `{"type":"audio","ts":...,"sampleRate":16000,"encoding":"pcm-f32"}`
   - Raw PCM payload
4. Send via `webSocket?.send(bytes.toByteString())`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Scan finds nothing | G1 not powered on, or pairing mode not active |
| `GATT_ERROR 133` | Common on first connect — retry once or power-cycle G1 |
| NUS service not found | Wrong device or firmware too old |
| Text not showing on G1 | Wrong command byte — test with `0x4E` + your string |
| WebSocket refused | Check agent is running; use LAN IP, not localhost |
| Permission denied on BLE scan | Grant Location + Bluetooth permissions in Settings |
