# @elizaos/capacitor-talkmode

Capacitor plugin for full voice conversation sessions: speech-to-text → chat orchestration → text-to-speech.

Runs inside Eliza agent apps on **iOS**, **Android**, **Electrobun (desktop)**, and **browser**. On native platforms, it uses platform STT (AVFoundation / SFSpeechRecognizer on iOS, Android SpeechRecognizer) and ElevenLabs streaming TTS with PCM/MP3 audio playback. On web, it falls back to the Web Speech API for both STT and TTS.

## Capabilities

- **Voice session management** — start/stop a hands-free, push-to-talk, compose, or passive session.
- **Live transcription** — streaming interim and final transcripts from the microphone.
- **TTS playback** — speak text via ElevenLabs (native only) or system TTS; supports per-utterance directives (voice, speed, stability, language, seed, latency tier).
- **Interrupt on speech** — automatically cut TTS playback when the user starts speaking.
- **Permission handling** — check and request microphone + speech recognition permissions.
- **Event-driven state machine** — `idle` → `listening` → `processing` → `speaking` → `error` with typed events.

## Installation

```bash
bun add @elizaos/capacitor-talkmode
npx cap sync
```

Peer dependency: `@capacitor/core ^8.3.1`.

On iOS, add the following to your `Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Used for voice conversations</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Used for speech-to-text transcription</string>
```

## Usage

```ts
import { TalkMode } from "@elizaos/capacitor-talkmode";

// Start a voice session with ElevenLabs TTS
const { started } = await TalkMode.start({
  config: {
    mode: "hands-free",
    tts: {
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: "your-voice-id",
      modelId: "eleven_flash_v2_5",
      interruptOnSpeech: true,
    },
    stt: {
      language: "en",
      sampleRate: 16000,
    },
    silenceWindowMs: 700,
  },
});

// Listen for transcripts
await TalkMode.addListener("transcript", (event) => {
  console.log(event.transcript, event.isFinal);
});

// Listen for state changes
await TalkMode.addListener("stateChange", (event) => {
  console.log(event.state, event.statusText);
});

// Speak a string directly
const result = await TalkMode.speak({
  text: "Hello from your Eliza agent.",
  directive: { speed: 1.1, language: "en-US" },
});

// Stop the session
await TalkMode.stop();
```

## Actions / Methods

| Method | Description |
|---|---|
| `start(options?)` | Begin a voice session |
| `stop()` | End the session and release audio resources |
| `isEnabled()` | Whether a session is currently active |
| `getState()` | Current state (`TalkModeState`) and status text |
| `updateConfig(options)` | Patch configuration mid-session |
| `speak(options)` | Speak text via TTS; returns completion result |
| `stopSpeaking()` | Interrupt TTS playback |
| `isSpeaking()` | Whether TTS is currently playing |
| `checkPermissions()` | Read microphone + speech recognition permission status |
| `requestPermissions()` | Prompt for required permissions |

## Events

| Event | Payload type | When fired |
|---|---|---|
| `stateChange` | `TalkModeStateEvent` | State machine transition |
| `transcript` | `TalkModeTranscriptEvent` | Interim or final STT result |
| `speaking` | `TTSSpeakingEvent` | TTS utterance starts |
| `speakComplete` | `TTSCompleteEvent` | TTS utterance finishes or is interrupted |
| `playbackStart` | `TalkModePlaybackStartEvent` | Native PCM/MP3 playback begins |
| `error` | `TalkModeErrorEvent` | Recoverable or fatal error |

## Configuration reference

All config is passed to `start()` or `updateConfig()` — no process env vars are read by this package.

| Field | Required | Description |
|---|---|---|
| `tts.apiKey` | Native TTS only | ElevenLabs API key |
| `tts.voiceId` | No | ElevenLabs voice ID |
| `tts.modelId` | No | ElevenLabs model (default: `eleven_flash_v2_5` on iOS) |
| `tts.outputFormat` | No | e.g. `"pcm_24000"`, `"mp3_44100"` |
| `tts.interruptOnSpeech` | No | Cut TTS when mic detects speech |
| `tts.voiceAliases` | No | Name → voiceId mapping |
| `stt.engine` | No | `"whisper"` or `"web"` |
| `stt.modelSize` | No | Whisper model size |
| `stt.language` | No | BCP-47 language code |
| `stt.sampleRate` | No | Hz, default 16000 |
| `silenceWindowMs` | No | Silence gap before finalising transcript |
| `mode` | No | Session mode (`compose`, `push-to-talk`, `hands-free`, `passive`) |
| `sessionKey` | No | Chat session key for orchestration |

## Platform notes

| Platform | STT | TTS |
|---|---|---|
| iOS / Android | Native platform API | ElevenLabs streaming + system TTS fallback |
| Electrobun (desktop) | Native STT | ElevenLabs streaming + system TTS fallback |
| Browser | Web Speech API | `SpeechSynthesis` only (ElevenLabs blocked by CORS) |

## Building

```bash
bun run --cwd plugins/plugin-native-talkmode build
```

Outputs ESM to `dist/esm/`, CJS to `dist/plugin.cjs.js`, and IIFE to `dist/plugin.js`.
