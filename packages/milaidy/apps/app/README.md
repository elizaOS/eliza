# Milaidy Capacitor App

A unified cross-platform application built with Capacitor, supporting iOS, Android, macOS, Linux, and Windows.

## Architecture

This application uses Capacitor as the cross-platform runtime, enabling deployment to:

- **iOS** - Native via Capacitor iOS
- **Android** - Native via Capacitor Android
- **macOS/Linux/Windows** - Desktop via Capacitor Electron

The web UI from `milaidy/apps/ui` is integrated and enhanced with native capabilities through custom Capacitor plugins.

## Custom Plugins

### Gateway Plugin (`@milaidy/capacitor-gateway`)

WebSocket connectivity to the Milaidy Gateway for agent communication.

```typescript
import { Gateway } from '@milaidy/capacitor-gateway';

// Connect to gateway
await Gateway.connect({ url: 'wss://gateway.example.com' });

// Send RPC request
const response = await Gateway.rpc({
  method: 'agent.invoke',
  params: { prompt: 'Hello' }
});

// Listen for events
Gateway.addListener('message', (event) => {
  console.log('Received:', event.data);
});
```

### Swabble Voice Plugin (`@milaidy/capacitor-swabble`)

Voice wake word detection and speech-to-text.

```typescript
import { Swabble } from '@milaidy/capacitor-swabble';

// Start listening with wake word triggers
await Swabble.start({
  config: {
    triggers: ['clawd', 'claude'],
    minPostTriggerGap: 0.45,
    minCommandLength: 1,
    locale: 'en-US'
  }
});

// Listen for wake word detection
Swabble.addListener('wakeWord', (event) => {
  console.log(`Wake word: ${event.wakeWord}`);
  console.log(`Command: ${event.command}`);
});

// Listen for transcripts
Swabble.addListener('transcript', (event) => {
  console.log(`Transcript: ${event.transcript}`);
});
```

### Camera Plugin (`@milaidy/capacitor-camera`)

Photo and video capture with advanced controls.

```typescript
import { Camera } from '@milaidy/capacitor-camera';

// Get available cameras
const { devices } = await Camera.getDevices();

// Start camera preview
await Camera.startPreview({
  element: document.getElementById('preview'),
  direction: 'back',
  resolution: { width: 1920, height: 1080 }
});

// Capture photo
const photo = await Camera.capturePhoto({
  quality: 90,
  format: 'jpeg'
});

// Start/stop video recording
await Camera.startRecording({ quality: 'high', audio: true });
const video = await Camera.stopRecording();
```

### Screen Capture Plugin (`@milaidy/capacitor-screencapture`)

Screen recording and screenshots.

```typescript
import { ScreenCapture } from '@milaidy/capacitor-screencapture';

// Capture screenshot
const screenshot = await ScreenCapture.captureScreenshot({
  format: 'png',
  quality: 100
});

// Start screen recording
await ScreenCapture.startRecording({
  quality: 'high',
  captureAudio: true,
  captureMicrophone: false
});

// Stop and get recording
const recording = await ScreenCapture.stopRecording();
```

### Canvas Plugin (`@milaidy/capacitor-canvas`)

A2UI integration and canvas rendering for agent-controlled UI.

```typescript
import { Canvas } from '@milaidy/capacitor-canvas';

// Create canvas
const { canvasId } = await Canvas.create({
  size: { width: 800, height: 600 },
  backgroundColor: { r: 255, g: 255, b: 255 }
});

// Attach to DOM
await Canvas.attach({
  canvasId,
  element: document.getElementById('canvas-container')
});

// Draw shapes
await Canvas.drawRect({
  canvasId,
  rect: { x: 100, y: 100, width: 200, height: 150 },
  fill: { color: { r: 66, g: 133, b: 244 } },
  cornerRadius: 8
});

// Draw text
await Canvas.drawText({
  canvasId,
  text: 'Hello World',
  position: { x: 150, y: 200 },
  style: { font: 'Arial', size: 24, color: '#333' }
});

// Export to image
const image = await Canvas.toImage({ canvasId, format: 'png' });
```

### Desktop Plugin (`@milaidy/capacitor-desktop`)

Desktop-specific features for Electron (system tray, global shortcuts, auto-launch).

```typescript
import { Desktop } from '@milaidy/capacitor-desktop';

// Create system tray
await Desktop.createTray({
  icon: '/assets/tray-icon.png',
  tooltip: 'Milaidy',
  menu: [
    { id: 'show', label: 'Show Window' },
    { id: 'separator', type: 'separator' },
    { id: 'quit', label: 'Quit' }
  ]
});

// Register global shortcut
await Desktop.registerShortcut({
  id: 'toggle',
  accelerator: 'CommandOrControl+Shift+O'
});

Desktop.addListener('shortcutPressed', (event) => {
  if (event.id === 'toggle') {
    Desktop.showWindow();
  }
});

// Enable auto-launch
await Desktop.setAutoLaunch({
  enabled: true,
  openAsHidden: true
});
```

## Project Structure

```
milaidy/apps/app/
├── src/
│   ├── main.ts           # Main entry point
│   └── bridge/           # Capacitor bridge utilities
├── plugins/
│   ├── gateway/          # Gateway WebSocket plugin
│   ├── swabble/          # Voice wake plugin
│   ├── camera/           # Camera plugin
│   ├── screencapture/    # Screen capture plugin
│   ├── canvas/           # Canvas rendering plugin
│   └── desktop/          # Desktop features plugin
├── ios/                  # iOS native project
├── android/              # Android native project
├── index.html            # HTML entry point
├── vite.config.ts        # Vite build config
├── capacitor.config.ts   # Capacitor config
└── package.json
```

## Development

### Prerequisites

- Node.js 18+
- Bun (recommended) or npm
- For iOS: macOS with Xcode 15+
- For Android: Android Studio with SDK 34+
- For Desktop: Electron (via @capacitor-community/electron)

### Setup

```bash
# Install dependencies
bun install

# Build plugins
bun run plugin:build

# Build web assets
bun run build
```

### Running on iOS

```bash
# Sync and open Xcode
bun run ios
```

### Running on Android

```bash
# Sync and open Android Studio
bun run android
```

### Running on Desktop (Electron)

```bash
# Sync and open Electron
bun run electron
```

### Development Server

```bash
# Start Vite dev server
bun run dev
```

## Building for Production

### iOS

1. Open Xcode: `bun run cap:open:ios`
2. Select your signing team
3. Archive and distribute

### Android

1. Open Android Studio: `bun run cap:open:android`
2. Build > Generate Signed Bundle/APK

### Desktop

1. Configure electron-builder in the electron folder
2. Build using `npx electron-builder`

## Configuration

### Capacitor Config (`capacitor.config.ts`)

```typescript
const config: CapacitorConfig = {
  appId: 'ai.milaidy.app',
  appName: 'Milaidy',
  webDir: 'dist',
  server: {
    hostname: 'milaidy.local',
    androidScheme: 'https',
    iosScheme: 'milaidy'
  },
  plugins: {
    // Plugin-specific configuration
  }
};
```

### Environment Variables

Create a `.env` file for configuration:

```env
VITE_GATEWAY_URL=wss://gateway.milaidy.ai
VITE_API_KEY=your-api-key
```

## Permissions

### iOS (Info.plist)

- `NSMicrophoneUsageDescription` - For voice wake and video recording
- `NSCameraUsageDescription` - For camera access
- `NSSpeechRecognitionUsageDescription` - For speech recognition

### Android (AndroidManifest.xml)

- `RECORD_AUDIO` - For voice wake and video recording
- `CAMERA` - For camera access
- `INTERNET` - For gateway connection

## License

MIT
