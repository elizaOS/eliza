# ElevenLabs Plugin for ElizaOS

High-quality text-to-speech (TTS) and speech-to-text (STT) plugin for ElizaOS using the ElevenLabs API.

## Features

- **Text-to-Speech (TTS)**: High-quality voice synthesis with multiple voice models
- **Speech-to-Text (STT)**: Accurate transcription with Scribe v1 model
- **Speaker Diarization**: Identify up to 32 different speakers
- **Multi-language Support**: 99 languages for STT
- **Audio Event Detection**: Detect laughter, applause, and other audio events
- **Streaming Support**: Efficient memory usage with streaming audio output
- **Multi-runtime**: Available for TypeScript, Python, and Rust

## Installation

### TypeScript (npm)

```bash
npm install @elizaos/plugin-elevenlabs
# or
bun add @elizaos/plugin-elevenlabs
```

### Python (PyPI)

```bash
pip install eliza-plugin-elevenlabs
```

### Rust (crates.io)

Add to your `Cargo.toml`:

```toml
[dependencies]
eliza-plugin-elevenlabs = "0.1.0"
```

## Quick Start

### TypeScript

```typescript
import { elevenLabsPlugin } from '@elizaos/plugin-elevenlabs';

// Add to your character configuration
const character = {
  plugins: ['@elizaos/plugin-elevenlabs'],
  settings: {
    ELEVENLABS_API_KEY: 'your-api-key',
  },
};
```

### Python

```python
from eliza_plugin_elevenlabs import ElevenLabsService

async with ElevenLabsService(api_key="your-api-key") as service:
    # Text-to-speech
    audio = await service.text_to_speech_bytes("Hello, world!")
    
    # Speech-to-text
    transcript = await service.speech_to_text(audio_bytes)
```

### Rust

```rust
use eliza_plugin_elevenlabs::ElevenLabsService;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = ElevenLabsService::new("your-api-key");
    
    // Text-to-speech
    let audio = service.text_to_speech("Hello, world!").await?;
    
    // Speech-to-text
    let transcript = service.speech_to_text(&audio).await?;
    
    Ok(())
}
```

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ELEVENLABS_API_KEY` | ElevenLabs API key | **Required** |
| `ELEVENLABS_VOICE_ID` | Voice ID for TTS | `EXAVITQu4vr4xnSDxMaL` |
| `ELEVENLABS_MODEL_ID` | TTS model ID | `eleven_monolingual_v1` |
| `ELEVENLABS_VOICE_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.75` |
| `ELEVENLABS_VOICE_STYLE` | Voice style intensity (0-1) | `0` |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | Enable speaker boost | `true` |
| `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY` | Latency optimization (0-4) | `0` |
| `ELEVENLABS_OUTPUT_FORMAT` | Audio output format | `mp3_44100_128` |
| `ELEVENLABS_BROWSER_URL` | Browser proxy URL | - |
| `ELEVENLABS_STT_MODEL_ID` | STT model ID | `scribe_v1` |
| `ELEVENLABS_STT_LANGUAGE_CODE` | Language code for STT | auto-detect |
| `ELEVENLABS_STT_TIMESTAMPS_GRANULARITY` | Timestamp detail level | `word` |
| `ELEVENLABS_STT_DIARIZE` | Enable speaker diarization | `false` |
| `ELEVENLABS_STT_NUM_SPEAKERS` | Expected number of speakers (1-32) | - |
| `ELEVENLABS_STT_TAG_AUDIO_EVENTS` | Tag audio events | `false` |

## Project Structure

```
plugin-elevenlabs/
├── package.json          # Root package with multi-language scripts
├── README.md             # This file
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml        # CI for all languages
│       ├── npm-deploy.yml    # npm publishing
│       ├── pypi-deploy.yml   # PyPI publishing
│       └── crates-deploy.yml # crates.io publishing
├── typescript/           # TypeScript implementation
│   ├── package.json
│   ├── src/
│   └── README.md
├── python/               # Python implementation
│   ├── pyproject.toml
│   ├── src/
│   └── README.md
└── rust/                 # Rust implementation
    ├── Cargo.toml
    ├── src/
    └── README.md
```

## Development

### Build All

```bash
bun run build
```

### Build Individual Languages

```bash
bun run build:ts      # TypeScript
bun run build:python  # Python
bun run build:rust    # Rust
```

### Test All

```bash
bun run test
```

### Test Individual Languages

```bash
bun run test:ts      # TypeScript
bun run test:python  # Python
bun run test:rust    # Rust
```

### Lint

```bash
bun run lint         # All languages
bun run lint:ts      # TypeScript
bun run lint:python  # Python
bun run lint:rust    # Rust
```

## Model Types

### TEXT_TO_SPEECH

Converts text into spoken audio. Supports:
- Multiple voice models
- Configurable voice parameters
- Streaming output
- Various audio formats (MP3, PCM, etc.)

### TRANSCRIPTION

Converts audio/video into text transcripts. Supports:
- 99 languages with auto-detection
- Speaker diarization (up to 32 speakers)
- Word/character-level timestamps
- Audio event tagging

## Supported Models

### TTS Models
- `eleven_monolingual_v1`
- `eleven_multilingual_v1`
- `eleven_multilingual_v2`
- `eleven_turbo_v2`
- `eleven_turbo_v2_5`

### STT Models
- `scribe_v1`

## License

MIT

## Links

- [ElevenLabs API Documentation](https://docs.elevenlabs.io/)
- [ElizaOS Documentation](https://elizaos.github.io/)
- [GitHub Repository](https://github.com/elizaos-plugins/plugin-elevenlabs)
