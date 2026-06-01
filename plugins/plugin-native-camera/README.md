# @elizaos/capacitor-camera

Capacitor plugin for camera preview, photo capture, and video recording. Works across web (via the `MediaDevices` API), iOS (via AVFoundation), and Android (via Camera2).

## What it does

- **Live preview** — stream a camera feed into any DOM element with configurable resolution, frame rate, and mirror mode.
- **Photo capture** — snapshot a JPEG, PNG, or WebP image as base64 from the active preview, with optional resize and quality control.
- **Video recording** — record video with optional audio, configurable bitrate, and automatic stop on max duration or file size.
- **Camera control** — zoom, focus point, exposure point, flash/torch mode, white balance.
- **Device enumeration** — list available cameras with capabilities (direction, zoom range, resolutions, frame rates).
- **Permissions** — check and request camera + microphone permissions.
- **Events** — subscribe to `frame`, `error`, and `recordingState` events.

## Installation

This is a Capacitor plugin. Add it to a Capacitor project:

```bash
npm install @elizaos/capacitor-camera
npx cap sync
```

### iOS

The plugin uses `AVFoundation`, `Photos`, and `UIKit`. Add the following keys to `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Camera access is required for photo and video capture.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is required for video recording with audio.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Photo library access is required to save captured media.</string>
```

Minimum deployment target: iOS 15.0.

### Android

Add the following permissions to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
```

## Usage

```typescript
import { Camera } from "@elizaos/capacitor-camera";

// Check and request permissions
const status = await Camera.checkPermissions();
if (status.camera !== "granted") {
  await Camera.requestPermissions();
}

// List available cameras
const { devices } = await Camera.getDevices();

// Start a preview in a DOM element
const container = document.getElementById("camera-container");
const result = await Camera.startPreview({
  element: container,
  direction: "back",
  resolution: { width: 1920, height: 1080 },
  frameRate: 30,
});

// Capture a photo
const photo = await Camera.capturePhoto({ quality: 90, format: "jpeg" });
// photo.base64 contains the image data

// Record video
await Camera.startRecording({ audio: true, quality: "high", maxDuration: 60 });
// ... later ...
const video = await Camera.stopRecording();
// video.path is a blob: URL on web, or a file path on native

// Stop preview and release camera
await Camera.stopPreview();
```

### Camera settings

```typescript
// Zoom (1.0 = no zoom)
await Camera.setZoom({ zoom: 2.0 });

// Manual focus / exposure (normalized 0–1 coordinates)
await Camera.setFocusPoint({ x: 0.5, y: 0.5 });
await Camera.setExposurePoint({ x: 0.5, y: 0.5 });

// Batch settings update
await Camera.setSettings({
  settings: {
    flash: "auto",
    whiteBalance: "daylight",
    focusMode: "continuous",
  },
});
```

### Events

```typescript
const frameHandle = await Camera.addListener("frame", (event) => {
  console.log(event.timestamp, event.width, event.height);
});

const stateHandle = await Camera.addListener("recordingState", (state) => {
  console.log(state.isRecording, state.duration, state.fileSize);
});

// Clean up
await Camera.removeAllListeners();
```

## API

Full TypeScript definitions are in `src/definitions.ts`. Key types:

| Type | Description |
|---|---|
| `CameraDevice` | Device info: id, label, direction, capabilities |
| `CameraPreviewOptions` | Options for `startPreview` |
| `PhotoCaptureOptions` | Options for `capturePhoto` (quality, format, size, gallery save) |
| `PhotoResult` | base64 image, format, dimensions, optional EXIF |
| `VideoCaptureOptions` | Options for `startRecording` (quality, duration, size, audio, bitrate) |
| `VideoResult` | Path (blob URL or file path), duration, dimensions, file size, mime type |
| `CameraSettings` | flash, zoom, focusMode, exposureMode, exposureCompensation, whiteBalance |
| `CameraPermissionStatus` | camera / microphone: `"granted"` \| `"denied"` \| `"prompt"`; photos additionally allows `"limited"` |

## Platform notes

- **Web:** Flash/torch is not controllable via the `MediaDevices` API on most desktop browsers. Manual focus and exposure require the browser/device to report `"manual"` capability. Video is recorded as a `blob:` URL using `MediaRecorder`; preferred codec order is `vp9+opus` → `vp8+opus` → `webm` → `mp4`.
- **iOS:** AVFoundation-backed. Requires iOS 15.0+, Swift 5.9.
- **Android:** Camera2 API-backed.
- **Node (Electrobun desktop):** Supported via Electrobun native modules.

