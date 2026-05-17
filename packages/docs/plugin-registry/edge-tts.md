---
title: "Edge TTS Plugin"
sidebarTitle: "Edge TTS"
description: "Free text-to-speech using Microsoft Edge TTS - no API key required"
---

Free text-to-speech synthesis using Microsoft Edge TTS, with no API key required.

**Package:** `@elizaos/plugin-edge-tts`

## Overview

The Edge TTS plugin provides text-to-speech capabilities for Eliza agents using Microsoft Edge's TTS engine. It supports a wide range of voices, adjustable speech rate, pitch, and volume. Since it leverages the Edge TTS service directly, no API key or paid subscription is needed.

## Installation

```bash
eliza plugins install edge-tts
```

## Auto-Enable

The plugin auto-enables when `EDGE_TTS_VOICE` is set.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `EDGE_TTS_VOICE` | string | No | Voice name (e.g., `en-US-AriaNeural`) |
| `EDGE_TTS_RATE` | string | No | Speech rate adjustment |
| `EDGE_TTS_PITCH` | string | No | Pitch adjustment |
| `EDGE_TTS_VOLUME` | string | No | Volume adjustment |

## Related

- [TTS Plugin](/plugin-registry/tts) - General text-to-speech plugin
- [ElevenLabs Plugin](/plugin-registry/elevenlabs) - Premium voice synthesis alternative
