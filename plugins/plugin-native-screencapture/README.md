# @elizaos/capacitor-screencapture

Cross-platform screen capture Capacitor plugin for elizaOS. Captures screenshots and records the screen on browser (Web API), iOS (ReplayKit + AVFoundation), and Android (MediaProjection).

## What it does

- **Screenshot:** Captures a single frame of the screen as a base64-encoded PNG, JPEG, or WebP image.
- **Screen recording:** Records the screen to a video file (WebM on browser, MP4 on native), with optional audio from the system, microphone, or both.
- **Pause / resume:** Pause and resume an active recording without creating a new file (Android requires API 24+).
- **Permission checks:** Query and request screen-capture and microphone permissions in a unified cross-platform API.
- **Live events:** Subscribe to `recordingState` and `error` events emitted during recording.

## Platform support

| Feature | Browser | iOS | Android |
|---------|---------|-----|---------|
| Screenshot | Yes (getDisplayMedia) | Yes (UIKit) | Yes (MediaProjection) |
| Screen recording | Yes (MediaRecorder) | Yes (ReplayKit) | Yes (MediaRecorder) |
| Pause/resume | Yes | Yes | API 24+ only |
| System audio | Browser-dependent | Yes (RPSampleBufferType.audioApp) | No (microphone only) |
| Microphone audio | Yes | Yes | Yes |

## Installation

```bash
npm install @elizaos/capacitor-screencapture
npx cap sync
```

For iOS, add to your app's `Info.plist`:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone is used to capture audio during screen recording.</string>
```

For Android 14+ (API 34), declare in `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
```
This is in addition to the `FOREGROUND_SERVICE` permission that this plugin's own `AndroidManifest.xml` already declares.

## Usage

```typescript
import { ScreenCapture } from '@elizaos/capacitor-screencapture';

// Check support
const { supported, features } = await ScreenCapture.isSupported();

// Take a screenshot
const shot = await ScreenCapture.captureScreenshot({ format: 'png', quality: 100 });
// shot.base64 contains the image data

// Record the screen
await ScreenCapture.startRecording({
  quality: 'high',        // 'low' | 'medium' | 'high' | 'highest'
  fps: 30,
  captureSystemAudio: true,
  captureMicrophone: false,
  maxDuration: 300,       // seconds; undefined = unlimited
});

// Listen for state updates
const handle = await ScreenCapture.addListener('recordingState', (state) => {
  console.log(`Recording: ${state.isRecording}, duration: ${state.duration}s`);
});

// Stop and get the result
const result = await ScreenCapture.stopRecording();
// result.path — blob: URL (browser) or filesystem path (native)
// result.mimeType — video/webm (browser) or video/mp4 (native)

await handle.remove();
```

## Permissions

Screen capture permission works differently per platform:

- **Browser:** `getDisplayMedia` always shows an OS-level picker dialog. There is no way to pre-grant or query this permission. `checkPermissions()` returns `"prompt"` when the API is available.
- **iOS:** Screenshots use UIKit only — no permission required. `startRecording` uses ReplayKit, which shows a system broadcast picker on first use.
- **Android:** `captureScreenshot` and `startRecording` both trigger a `MediaProjection` consent dialog. Microphone permission (`RECORD_AUDIO`) is requested at runtime when `captureMicrophone: true`.

```typescript
// Check permissions
const status = await ScreenCapture.checkPermissions();
// status.screenCapture: 'granted' | 'denied' | 'prompt' | 'not_supported'
// status.microphone:    'granted' | 'denied' | 'prompt'

// Request microphone permission before recording with audio
await ScreenCapture.requestPermissions();
```

## Output formats

| Platform | Screenshot | Recording |
|----------|-----------|-----------|
| Browser  | PNG / JPEG / WebP | video/webm (VP9 preferred), blob: URL |
| iOS      | PNG / JPEG / WebP (WebP requires iOS 14+) | video/mp4 (H.264 + AAC), file:// path |
| Android  | PNG / JPEG / WebP (WebP lossy requires API 30+) | video/mp4 (H.264), file path |

## Recording options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quality` | `'low' \| 'medium' \| 'high' \| 'highest'` | `'high'` | Quality preset (sets bitrate on iOS; sets fps + bitrate on Android) |
| `fps` | `number` | 30 | Frames per second (1–60; overrides quality preset) |
| `bitrate` | `number` | Estimated | Video bitrate in bits/s (overrides quality preset) |
| `maxDuration` | `number` | unlimited | Stop automatically after N seconds |
| `maxFileSize` | `number` | unlimited | Stop automatically after N bytes |
| `captureSystemAudio` | `boolean` | `true` | Include app/system audio (browser + iOS; Android records microphone only) |
| `captureMicrophone` | `boolean` | `false` | Include microphone audio in recording |

## Building from source

```bash
bun run --cwd plugins/plugin-native-screencapture build
```

This runs `tsc` then `rollup` and outputs `dist/esm/`, `dist/plugin.js` (IIFE), and `dist/plugin.cjs.js`.
