---
title: Talk Mode
sidebarTitle: Talk Mode
description: Full voice conversation with your Eliza agent using offline speech recognition, text-to-speech, and voice activity detection.
---

Talk Mode provides a full voice conversation pipeline for the Eliza desktop app. It combines offline speech-to-text (Whisper.cpp), streaming text-to-speech (ElevenLabs), and voice activity detection into a seamless hands-free experience.

<Info>
Talk Mode is a native desktop feature. It requires the Electrobun desktop app — it is not available in the web dashboard or mobile app.
</Info>

## How It Works

1. **You speak** — the microphone captures audio and streams PCM samples to the main process
2. **Speech recognition** — Whisper.cpp transcribes your speech to text offline
3. **Agent processes** — the transcript is sent to the agent as a message
4. **Agent speaks** — the response is converted to speech via ElevenLabs and played back

### State Machine

Talk Mode cycles through four states:

| State | Description |
|-------|-------------|
| `idle` | Talk Mode is off |
| `listening` | Microphone is active, waiting for speech |
| `processing` | Transcription complete, agent is generating a response |
| `speaking` | Agent response is being played back as audio |

After `speaking` completes, Talk Mode returns to `listening` for the next turn.

## Configuration

Talk Mode is configured through the `TalkModeConfig` interface:

### Speech-to-Text (STT)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `engine` | string | `"whisper"` | `"whisper"` for offline Whisper.cpp, `"web"` for browser Web Speech API |
| `modelSize` | string | `"base"` | Whisper model size: `"tiny"`, `"base"`, `"small"`, `"medium"`, `"large"` |
| `language` | string | — | Optional language code for transcription |

Larger Whisper models are more accurate but require more memory and processing time. If Whisper is unavailable, Talk Mode falls back to the Web Speech API automatically.

### Text-to-Speech (TTS)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `engine` | string | `"elevenlabs"` | `"elevenlabs"` for ElevenLabs API, `"system"` for native OS TTS |
| `apiKey` | string | — | ElevenLabs API key (configured in Settings > Secrets) |
| `voiceId` | string | — | ElevenLabs voice ID |
| `modelId` | string | `"eleven_v3"` | ElevenLabs model |

Falls back to system TTS if no ElevenLabs API key is configured.

### Voice Activity Detection (VAD)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable voice activity detection |
| `silenceThreshold` | number | — | Audio level below which silence is detected |
| `silenceDuration` | number | — | Duration of silence (ms) before stopping capture |

## Permissions

Talk Mode requires the **microphone** permission. In the desktop app, you can grant this from **Settings > Permissions**.

## IPC Events

Talk Mode communicates between the renderer and main process via IPC:

### Commands (Renderer → Main)

| Channel | Description |
|---------|-------------|
| `talkmode:start` | Start Talk Mode |
| `talkmode:stop` | Stop Talk Mode |
| `talkmode:speak` | Trigger TTS for text |
| `talkmode:stopSpeaking` | Interrupt current playback |
| `talkmode:isSpeaking` | Query speaking state |
| `talkmode:getState` | Query current state |
| `talkmode:isEnabled` | Check if Talk Mode is available |
| `talkmode:updateConfig` | Update configuration |
| `talkmode:isWhisperAvailable` | Check Whisper.cpp availability |
| `talkmode:getWhisperInfo` | Get Whisper model info |

### Events (Main → Renderer)

| Channel | Description |
|---------|-------------|
| `talkmode:transcript` | Transcription result with `isFinal` flag |
| `talkmode:speaking` | Speaking state changed |
| `talkmode:speakComplete` | Playback finished |
| `talkmode:audioChunk` | Base64-encoded audio chunk for playback |
| `talkmode:audioComplete` | All audio chunks sent |
| `talkmode:stateChange` | State machine transition |
| `talkmode:error` | Error with diagnostic `code` |

## Related

- [Desktop App](/apps/desktop) — desktop-specific features and keyboard shortcuts
- [Native Modules](/apps/desktop/native-modules) — IPC reference for Talk Mode and other native features
- [Settings](/apps/dashboard/settings) — TTS/STT provider configuration
