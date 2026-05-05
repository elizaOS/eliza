---
title: "Speech-to-Text Plugin"
sidebarTitle: "Speech-to-Text"
description: "Speech-to-text plugin for Eliza — transcribe audio input into text for voice-enabled agent interactions."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry. For speech-to-text, check available provider plugins that include STT support.
</Warning>

The Speech-to-Text (STT) plugin enables Eliza agents to transcribe audio input into text, powering voice-based interactions.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when configured. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-stt`

## Installation

```bash
eliza plugins install @elizaos/plugin-stt
```

## Enable via Features

```json
{
  "features": {
    "stt": true
  }
}
```

The STT plugin uses the configured model provider for transcription. No additional API key is needed beyond your primary provider.

## Features

- Audio transcription to text
- Voice input support for agent conversations
- Works alongside the [TTS plugin](/plugin-registry/tts) for full voice interaction
- Integrates with Talk mode for real-time voice conversations

## Related

- [TTS Plugin](/plugin-registry/tts) — Text-to-speech output
- [Browser Plugin](/plugin-registry/browser) — Web automation
