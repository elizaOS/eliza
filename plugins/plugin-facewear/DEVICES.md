# Facewear Devices Guide

This document covers all supported devices, connection setup, emulator usage, and troubleshooting.

## Supported Devices

| Device | Connection | Emulator | Native App | Status |
|--------|-----------|----------|------------|--------|
| Meta Quest 3 / 3S / Pro | WebXR (WebSocket) | ✅ IWER | Android TWA | Ready |
| XReal Air 3 / One Pro | WebXR (WebSocket) | ✅ IWER | Android native | Ready |
| Even Realities G1 / G2 | BLE (GATT) | ✅ Mock | Android companion | Ready |
| Apple Vision Pro | WebXR + visionOS | ✅ IWER | visionOS Swift | Ready |
| Browser (simulator) | WebXR (WebSocket) | ✅ IWER | N/A | Ready |

## Architecture

All WebXR devices (Quest, XReal, Vision Pro) use the same WebSocket streaming protocol:
1. Device connects to `ws://AGENT_HOST:31338/ws-xr`
2. Device sends binary frames (audio chunks + camera frames)
3. Agent responds with transcripts, agent text, TTS audio, and view control messages

Even Realities G1/G2 uses BLE GATT:
1. Noble/WebBluetooth connects to G1 via UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
2. Commands are encoded with the G1 binary protocol
3. Audio is streamed as LC3 audio from the G1 RX characteristic

## Meta Quest 3 Setup

### WebXR (Recommended)
1. Start elizaOS with plugin-facewear
2. Put on Quest 3, open Meta Browser
3. Visit `http://AGENT_IP:2138/api/xr/connect` for QR code
4. Scan QR code in Quest Browser → Allow camera and mic
5. Connection established — voice and views work immediately

### Native TWA (APK)
See `native/android/quest/README.md`. Requires Android SDK + Bubblewrap CLI.
```bash
cd native/android/quest
npm install
bubblewrap build
bubblewrap install
```

## XReal Setup

### WebXR
Same as Quest 3 — open the agent URL in XReal's Nebula browser.

### Native App (XREAL SDK 3.0.0)
See `native/android/xreal/README.md`. Requires XREAL SDK 3.0.0 (manual download from https://developer.xreal.com/).

## Even Realities G1/G2 Setup

### Auto-connect (recommended)
1. Plugin-facewear detects the configured transport (`FACEWEAR_SMARTGLASSES_TRANSPORT`)
2. Auto-select order: even-bridge (native app) → web-bluetooth → noble
3. On connect, the G1 receives an init packet and begins mic/display streaming

### Transport options
- **even-bridge**: Use when running inside the Even Realities companion iOS/Android app
- **web-bluetooth**: Use in Chrome/Edge browser on Mac/Windows/Android
- **noble**: Use in CLI/server environments (requires `@abandonware/noble`)

### Android companion app
See `native/android/even-realities/README.md`. Connects G1 via Android BluetoothGATT and bridges to the elizaOS agent WebSocket.

## Apple Vision Pro Setup

### WebXR (Safari / WKWebView)
1. Start elizaOS with plugin-facewear
2. In Vision Pro, open Safari
3. Visit `https://AGENT_HOST/api/xr/connect` (HTTPS required for getUserMedia)
4. Tap Allow on camera and microphone prompts
5. Tap "Enter Immersive" to start WebXR session

### Native App (ElizaFacewear visionOS)
See `native/visionos/README.md`. Requires Xcode 16+ + Apple Developer account + visionOS 2.4 SDK.

Architecture: SwiftUI app → WKWebView (WebXR) OR direct native RealityKit rendering. Agent runs externally (Mac or cloud).

## Device Emulator

The emulator (`emulator/`) is a browser-based IWER WebXR simulator. It serves at `/api/xr/simulator.js`.

### Running in tests
The Playwright test fixtures automatically load the emulator:
```typescript
import { test } from "../emulator/src/playwright-fixture.ts";
test("my test", async ({ xrPage }) => {
  await xrPage.connect({ deviceType: "quest3" });
});
```

### DeviceEmulator (programmatic)
```typescript
import { DeviceEmulator } from "./emulator/src/device-emulator.ts";
const em = new DeviceEmulator("meta-quest");
await em.connect("ws://localhost:31338/ws-xr");
em.sendAudioChunk(pcmData, "pcm-f32");
em.onMessage((msg) => console.log(msg));
```

## Troubleshooting

### "WebXR not supported"
- Ensure HTTPS (use `bun run connect` for localtunnel)
- Quest: use Meta Browser (not Browser app)
- XReal: use Nebula browser
- Vision Pro: Safari 17+ required

### Even Realities not connecting
1. Check Bluetooth is enabled and not in airplane mode
2. Ensure glasses are powered on (single tap to wake)
3. Try `FACEWEAR_SMARTGLASSES_TRANSPORT=noble` for explicit BLE scanning
4. Check `FACEWEAR_SCAN_TIMEOUT_MS` is at least 10000

### Audio not streaming
- Allow microphone permission in the browser prompt
- Quest: ensure Meta Browser has mic permission in Quest settings
- Check `FACEWEAR_WS_PORT` matches the agent port

### Views not loading
- Ensure all 24+ view bundles are built: run `bun run build:views` in each plugin
- Check `/api/xr/view-host/facewear` returns HTTP 200
- Check browser console for import errors (missing CDN imports)

## SDK Versions Reference

| SDK | Version | Required For |
|-----|---------|-------------|
| Meta XR SDK | 68.0 | Quest native APK |
| XREAL SDK | 3.0.0 | XReal native (NRCameraRig) |
| Even Realities G1 Protocol | built-in | G1/G2 BLE |
| visionOS SDK | 2.4 | Apple Vision Pro native |
| WebXR (browser) | standard | All WebXR devices |
| @abandonware/noble | 1.9.2+ | BLE CLI/server |
