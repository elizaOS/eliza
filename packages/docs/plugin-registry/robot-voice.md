---
title: "Robot Voice Plugin"
sidebarTitle: "Robot Voice"
description: "Retro 1980s SAM Text-to-Speech plugin for Eliza agents."
---

The Robot Voice plugin gives Eliza agents a retro 1980s synthesized voice using the SAM (Software Automatic Mouth) Text-to-Speech engine.

**Package:** `@elizaos/plugin-robot-voice`

## Overview

SAM (Software Automatic Mouth) was one of the first commercial Text-to-Speech programs, originally released for the Commodore 64 in 1982. This plugin integrates a SAM TTS engine into the elizaOS runtime, giving agents a distinctive robotic voice for audio responses.

The Robot Voice plugin is a TTS provider — once installed, the agent's text responses can be converted to audio using the classic SAM synthesis engine.

## Installation

```bash
eliza plugins install robot-voice
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage

Once enabled, the plugin registers as a TTS provider in the elizaOS runtime. Agents with voice output enabled will use SAM to synthesize spoken responses with a characteristic retro robot sound.

## Related

- [Simple Voice Plugin](/plugin-registry/robot-voice) — Lightweight SAM-based TTS
- [Edge TTS Plugin](/plugin-registry/edge-tts) — Microsoft Edge neural TTS
- [ElevenLabs Plugin](/plugin-registry/elevenlabs) — High-quality neural voice synthesis
