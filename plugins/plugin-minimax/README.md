# @elizaos/plugin-minimax

MiniMax AI provider plugin for [ElizaOS](https://github.com/elizaOS/eliza) — adds support for MiniMax's chat completion and text-to-speech models.

## Features

- **Chat Completion**: MiniMax-M2.5 and MiniMax-M2.5-highspeed models with 204K context window
- **Text-to-Speech**: MiniMax speech-2.8-hd with multiple voice options
- **OpenAI-compatible API**: Uses MiniMax's OpenAI-compatible endpoint

## Models

### Chat Models

| Model | Type | Description |
|-------|------|-------------|
| `MiniMax-M2.5` | TEXT_LARGE | Peak Performance. Ultimate Value. Master the Complex |
| `MiniMax-M2.5-highspeed` | TEXT_SMALL | Same performance, faster and more agile |

Both models support 204,800 tokens context window with up to 192K output tokens.

### Pricing

| Model | Input | Output |
|-------|-------|--------|
| MiniMax-M2.5 | $0.3 / M tokens | $1.2 / M tokens |
| MiniMax-M2.5-highspeed | $0.6 / M tokens | $2.4 / M tokens |

### TTS Models

| Model | Description |
|-------|-------------|
| `speech-2.8-hd` | Perfecting tonal nuances with maximized timbre similarity (default) |
| `speech-2.8-turbo` | Faster, more affordable version |

### Available Voices

| Voice ID | Description |
|----------|-------------|
| `English_Graceful_Lady` | English female, elegant |
| `English_Insightful_Speaker` | English male, composed |
| `English_radiant_girl` | English female, lively |
| `English_Persuasive_Man` | English male, persuasive |
| `English_Lucky_Robot` | English, robot style |

## Setup

1. Get your API key from [MiniMax Platform](https://platform.minimax.io/)

2. Set the environment variable:
   ```bash
   MINIMAX_API_KEY=your_api_key_here
   ```

3. Add the plugin to your character configuration:
   ```json
   {
     "plugins": ["@elizaos/plugin-minimax"]
   }
   ```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MINIMAX_API_KEY` | Yes | — | MiniMax API key |
| `MINIMAX_BASE_URL` | No | `https://api.minimax.io/v1` | API base URL (use `https://api.minimaxi.com/v1` for China region) |

## API Constraints

- **Temperature**: Must be in range (0.0, 1.0]. A value of 0 is automatically adjusted to 0.01.
- **response_format**: Not supported. JSON output is achieved through prompt engineering.

## Documentation

- [MiniMax Platform](https://platform.minimax.io/)
- [Chat API Reference](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [TTS API Reference](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
