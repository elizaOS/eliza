# @elizaos/plugin-simple-voice

Retro 1980s SAM (Software Automatic Mouth) Text-to-Speech plugin for ElizaOS agents.

Available in **TypeScript**, **Python**, and **Rust**.

## Overview

SAM was a speech synthesizer from the 1980s known for its distinctive robotic voice. This plugin provides formant-based synthesis across three languages with identical APIs and feature parity.

## Features

- 🎙️ Authentic retro voice synthesis
- 🔊 Hardware bridge integration for audio output
- ⚙️ Voice parameter control (speed, pitch, throat, mouth)
- 🎯 Natural language trigger detection
- 🎵 WAV format output

## Voice Parameters

| Parameter | Range  | Default | Description        |
| --------- | ------ | ------- | ------------------ |
| Speed     | 20-200 | 72      | Speaking rate      |
| Pitch     | 0-255  | 64      | Voice pitch        |
| Throat    | 0-255  | 128     | Throat resonance   |
| Mouth     | 0-255  | 128     | Mouth articulation |

## Trigger Phrases

The SAY_ALOUD action responds to:

- `say aloud`, `speak`, `read aloud`
- `announce`, `proclaim`, `voice`
- `say "quoted text"`, `speak 'quoted text'`
- Voice modifiers: `higher voice`, `robotic`, `slower`

## Usage

### TypeScript

```typescript
import { simpleVoicePlugin, SamTTSService } from "@elizaos/plugin-simple-voice";

// As plugin
const runtime = new AgentRuntime({ plugins: [simpleVoicePlugin] });

// Direct usage
const service = new SamTTSService(runtime);
const audio = service.generateAudio("Hello world", {
  speed: 72,
  pitch: 64,
  throat: 128,
  mouth: 128,
});
const wav = service.createWAVBuffer(audio);
```

### Python

```python
from eliza_plugin_simple_voice import SamTTSService, SamTTSOptions

service = SamTTSService()
audio = service.generate_audio("Hello world", SamTTSOptions(speed=72))
wav = service.create_wav_buffer(audio)
```

### Rust

```rust
use eliza_plugin_simple_voice::{SamTTSService, SamTTSOptions};

let service = SamTTSService::default();
let audio = service.generate_audio("Hello world", Some(SamTTSOptions::default()));
let wav = service.create_wav_buffer(&audio, 22050);
```

## Installation

```bash
# TypeScript
cd typescript && bun install && bun run build

# Python
cd python && pip install -e .

# Rust
cd rust && cargo build --release
```

## Testing

```bash
# TypeScript
cd typescript && npx vitest

# Python
cd python && pytest

# Rust
cd rust && cargo test
```

## Architecture

```
plugin-simple-voice/
├── typescript/          # TypeScript implementation
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── actions/sayAloud.ts
│   │   └── services/SamTTSService.ts
│   └── package.json
├── python/              # Python implementation
│   ├── src/eliza_plugin_simple_voice/
│   │   ├── __init__.py
│   │   ├── types.py
│   │   ├── sam_engine.py
│   │   ├── actions/say_aloud.py
│   │   └── services/sam_tts_service.py
│   └── pyproject.toml
└── rust/                # Rust implementation
    ├── src/
    │   ├── lib.rs
    │   ├── types.rs
    │   ├── sam_engine.rs
    │   ├── actions/say_aloud.rs
    │   └── services/sam_tts_service.rs
    └── Cargo.toml
```

## Audio Pipeline

```
Text → Phoneme Conversion → Formant Synthesis → 8-bit PCM → WAV → Hardware Bridge
```

## License

MIT
