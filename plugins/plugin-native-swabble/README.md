# @elizaos/capacitor-swabble

Capacitor plugin for wake-word detection and live speech transcription. Integrates with Eliza agent UIs to give users a hands-free voice interface across iOS, Android, browser, and desktop (Electrobun + Whisper.cpp).

## What it does

- Listens for configurable trigger phrases ("eliza", "hey assistant", etc.) and emits a `wakeWord` event carrying the detected command text.
- Streams interim and final speech transcripts via a `transcript` event.
- Exposes microphone state changes, audio level data (for VU-meter visualizations), and errors as typed events.
- Manages microphone permissions across platforms.

## Platforms

| Platform | STT backend | Timing data |
|----------|-------------|-------------|
| iOS / macOS | Apple Speech framework | Yes |
| Android | SpeechRecognizer API | Partial |
| Browser | Web Speech API | No (postGap = -1) |
| Desktop (Electrobun) | Whisper.cpp via IPC bridge | Yes |

## Installation

```bash
npm install @elizaos/capacitor-swabble @capacitor/core
npx cap sync
```

iOS requires the `Speech` and `AVFoundation` frameworks (linked automatically via the podspec). Android requires `RECORD_AUDIO` permission in your manifest.

## Usage

```typescript
import { Swabble } from "@elizaos/capacitor-swabble";

// Request microphone permission
await Swabble.requestPermissions();

// Listen for wake word + command
const handle = await Swabble.addListener("wakeWord", (event) => {
  console.log("Wake word:", event.wakeWord);
  console.log("Command:", event.command);
});

// Start detection
await Swabble.start({
  config: {
    triggers: ["eliza"],
    minCommandLength: 3,
    locale: "en-US",
    modelSize: "small", // Whisper model for desktop
  },
});

// Stop later
await Swabble.stop();
handle.remove();
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `triggers` | `string[]` | required | Wake phrases to detect |
| `minPostTriggerGap` | `number` | — | Silence (seconds) required after trigger before command (native only) |
| `minCommandLength` | `number` | `1` | Minimum command length in characters |
| `locale` | `string` | `"en-US"` | Speech recognition locale |
| `sampleRate` | `number` | `16000` | Audio sample rate (Hz) |
| `modelSize` | `"tiny"\|"base"\|"small"\|"medium"\|"large"` | — | Whisper.cpp model size (desktop only) |

## Events

| Event | Description |
|-------|-------------|
| `wakeWord` | Trigger phrase detected; carries `wakeWord`, `command`, `transcript`, `postGap`, `confidence` |
| `transcript` | Speech transcript update (interim and final); carries segments with timing |
| `stateChange` | Microphone state: `idle`, `listening`, `processing`, `error` |
| `audioLevel` | RMS level + peak (~10 Hz); useful for microphone visualizations |
| `error` | Error with `code`, `message`, and `recoverable` flag |

## Known limitations

- **Web Speech API:** `postGap`, `start`, and `duration` in transcript segments are `-1` (timing unavailable). `setAudioDevice` throws on web.
- **Device selection:** Only supported on native platforms; ignored or rejected on browser.

## Building

```bash
bun run build   # tsc then rollup — produces dist/esm/, dist/plugin.js, dist/plugin.cjs.js
bun run watch   # tsc --watch (no rollup)
```
