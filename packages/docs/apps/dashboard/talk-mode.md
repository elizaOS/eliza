---
title: Talk Mode
sidebarTitle: Talk Mode
description: Full voice conversation with your Eliza agent using renderer speech recognition, text-to-speech, and voice activity detection.
---

Talk Mode provides a full voice conversation pipeline for the Eliza desktop app. The current Electrobun bridge uses renderer speech recognition for speech-to-text, streaming text-to-speech through ElevenLabs when configured, and voice activity detection for turn boundaries.

<Info>
Talk Mode is a native desktop feature. It requires the Electrobun desktop app — it is not available in the web dashboard or mobile app.
</Info>

## How It Works

1. **You speak** — the microphone captures audio and streams PCM samples to the main process
2. **Speech recognition** — the desktop bridge delegates transcription to the renderer speech recognizer
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
| `engine` | string | `"web"` | Active desktop speech recognizer. The current Electrobun RPC schema supports `"web"`. |
| `modelSize` | string | `"base"` | Legacy compatibility field; ignored by the Web Speech path |
| `language` | string | — | Optional language code for transcription |

Local-inference ASR is configured separately through the voice/local models path and requires an explicitly verified Gemma ASR bundle.

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
| `talkmode:audioChunk` | Submit a base64-encoded audio chunk while listening |

### Events (Main → Renderer)

| Channel | Description |
|---------|-------------|
| `talkmode:transcript` | Transcription result with `isFinal` flag |
| `talkmode:speakComplete` | Playback finished |
| `talkmode:audioChunkPush` | Base64-encoded audio chunk for playback or renderer-side recognition |
| `talkmode:stateChanged` | State machine transition |
| `talkmode:error` | Error with diagnostic `code` |

## Related

- [Desktop App](/apps/desktop) — desktop-specific features and keyboard shortcuts
- [Native Modules](/apps/desktop/native-modules) — IPC reference for Talk Mode and other native features
- [Settings](/apps/dashboard/settings) — TTS/STT provider configuration
