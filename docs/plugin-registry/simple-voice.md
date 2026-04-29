---
title: "Simple Voice Plugin"
sidebarTitle: "Simple Voice"
description: "Retro 1980s SAM Text-to-Speech plugin for Milady agents."
---

The Simple Voice plugin provides a lightweight Text-to-Speech capability for Milady agents using the SAM (Software Automatic Mouth) speech synthesizer.

**Package:** `@elizaos/plugin-simple-voice`

## Overview

This plugin integrates the SAM (Software Automatic Mouth) TTS engine into the elizaOS runtime, providing a simple, dependency-free voice output option for agents. SAM produces a characteristic retro 1980s synthesized voice, originally made famous on the Commodore 64.

The Simple Voice plugin focuses on minimal setup — no API keys, no external services, no network calls. It runs entirely locally and produces audio output immediately.

## Installation

```bash
milady plugins install simple-voice
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage

Once enabled, the plugin registers as a TTS provider in the elizaOS runtime. Agents with voice output enabled will use SAM to synthesize spoken responses.

## Related

- [Robot Voice Plugin](/plugin-registry/robot-voice) — SAM-based TTS with robotic character
- [Edge TTS Plugin](/plugin-registry/edge-tts) — Microsoft Edge neural TTS
- [ElevenLabs Plugin](/plugin-registry/elevenlabs) — High-quality neural voice synthesis
