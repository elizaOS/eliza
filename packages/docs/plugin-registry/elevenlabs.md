---
title: "ElevenLabs Plugin"
sidebarTitle: "ElevenLabs"
description: "ElevenLabs voice plugin for text-to-speech generation and conversational audio output"
---

High-quality voice synthesis for Eliza agents using the ElevenLabs API.

**Package:** `@elizaos/plugin-elevenlabs`

## Overview

The ElevenLabs plugin integrates ElevenLabs' text-to-speech API into Eliza, enabling agents to generate natural-sounding speech and conversational audio. It supports multiple models, voice customization (stability, similarity boost, style), streaming latency optimization, and configurable output formats.

## Installation

```bash
eliza plugins install elevenlabs
```

## Auto-Enable

The plugin auto-enables when `ELEVENLABS_XI_API_KEY` is set.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `ELEVENLABS_XI_API_KEY` | string | Yes | ElevenLabs API key |
| `ELEVENLABS_MODEL_ID` | string | No | Model ID (default: `eleven_multilingual_v2`) |
| `ELEVENLABS_VOICE_ID` | string | No | Voice ID |
| `ELEVENLABS_VOICE_STABILITY` | string | No | Voice stability (0-1) |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | string | No | Similarity boost (0-1) |
| `ELEVENLABS_VOICE_STYLE` | string | No | Voice style (0-1) |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | boolean | No | Use speaker boost |
| `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY` | string | No | Optimize streaming latency (0-4) |
| `ELEVENLABS_OUTPUT_FORMAT` | string | No | Output audio format |

## Related

- [TTS Plugin](/plugin-registry/tts) - General text-to-speech plugin
- [Edge TTS Plugin](/plugin-registry/edge-tts) - Free TTS alternative (no API key)
- [STT Plugin](/plugin-registry/stt) - Speech-to-text plugin
