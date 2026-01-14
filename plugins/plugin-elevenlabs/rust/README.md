# ElevenLabs Plugin for ElizaOS (Rust)

High-quality text-to-speech (TTS) and speech-to-text (STT) plugin for ElizaOS using the ElevenLabs API.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
eliza-plugin-elevenlabs = "0.1.0"
```

## Features

- **Text-to-Speech (TTS)**: High-quality voice synthesis with multiple voice models
- **Speech-to-Text (STT)**: Accurate transcription with Scribe v1 model
- **Speaker Diarization**: Identify up to 32 different speakers
- **Multi-language Support**: 99 languages for STT
- **Audio Event Detection**: Detect laughter, applause, and other audio events
- **Streaming Support**: Efficient memory usage with streaming audio output

## Usage

```rust
use eliza_plugin_elevenlabs::{ElevenLabsService, ElevenLabsTTSOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = ElevenLabsService::new("your-api-key");
    
    // Text-to-speech
    let audio = service.text_to_speech("Hello, world!").await?;
    
    // Speech-to-text
    let transcript = service.speech_to_text(&audio_bytes).await?;
    
    Ok(())
}
```

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ELEVENLABS_API_KEY` | ElevenLabs API key | Required |
| `ELEVENLABS_VOICE_ID` | Voice ID for TTS | `EXAVITQu4vr4xnSDxMaL` |
| `ELEVENLABS_MODEL_ID` | TTS model ID | `eleven_monolingual_v1` |
| `ELEVENLABS_VOICE_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.75` |
| `ELEVENLABS_OUTPUT_FORMAT` | Audio output format | `mp3_44100_128` |
| `ELEVENLABS_STT_MODEL_ID` | STT model ID | `scribe_v1` |
| `ELEVENLABS_STT_DIARIZE` | Enable speaker diarization | `false` |

## License

MIT
