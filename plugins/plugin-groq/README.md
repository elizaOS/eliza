# @elizaos/plugin-groq

Groq LLM plugin for elizaOS - Fast inference with Llama, Qwen, and other models.

This plugin provides Groq API integration for elizaOS agents, enabling ultra-fast text generation, audio transcription, and text-to-speech synthesis.

## Features

- 🚀 **Fast Inference** - Leverage Groq's LPU for industry-leading inference speeds
- 📝 **Text Generation** - Generate text with Llama, Qwen, and other models
- 🎤 **Audio Transcription** - Transcribe audio with Whisper models
- 🔊 **Text-to-Speech** - Generate speech with PlayAI voices
- 🔢 **Object Generation** - Generate structured JSON objects
- 🎯 **Tokenization** - Tokenize and detokenize text

## Installation

### TypeScript/JavaScript (npm)

```bash
npm install @elizaos/plugin-groq
# or
bun add @elizaos/plugin-groq
```
## Usage

### TypeScript

```typescript
import { groqPlugin } from "@elizaos/plugin-groq";

// Add to your agent's plugins
const agent = new Agent({
  plugins: [groqPlugin],
});
```
## Configuration

Set the following environment variables:

| Variable           | Required | Default                          | Description           |
| ------------------ | -------- | -------------------------------- | --------------------- |
| `GROQ_API_KEY`     | Yes      | -                                | Your Groq API key     |
| `GROQ_BASE_URL`    | No       | `https://api.groq.com/openai/v1` | Custom API base URL   |
| `GROQ_SMALL_MODEL` | No       | `openai/gpt-oss-20b`           | Model for small tasks |
| `GROQ_LARGE_MODEL` | No       | `llama-3.3-70b-versatile`        | Model for large tasks |
| `GROQ_TTS_MODEL`   | No       | `canopylabs/orpheus-v1-english`  | Text-to-speech model  |
| `GROQ_TTS_VOICE`   | No       | `troy`                           | TTS voice name        |
| `GROQ_TTS_RESPONSE_FORMAT` | No | `wav`                          | TTS response format   |

## Model Capabilities

This plugin provides handlers for the following elizaOS model types:

| Model Type              | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `TEXT_SMALL`            | Fast text generation with smaller models        |
| `TEXT_LARGE`            | High-quality text generation with larger models |
| `OBJECT_SMALL`          | JSON object generation (small)                  |
| `OBJECT_LARGE`          | JSON object generation (large)                  |
| `TRANSCRIPTION`         | Audio transcription with Whisper                |
| `TEXT_TO_SPEECH`        | Speech synthesis with PlayAI                    |
| `TEXT_TOKENIZER_ENCODE` | Tokenize text to tokens                         |
| `TEXT_TOKENIZER_DECODE` | Detokenize tokens to text                       |

## Development

### Building from Source

```bash
# TypeScript
bun install
bun run build
# TypeScript
bun run test
# TypeScript
bun run format:check