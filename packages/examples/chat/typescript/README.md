# Eliza Chat Example

Interactive CLI chat with an AI agent using ElizaOS. Supports multiple LLM providers.

## Supported Providers

The chat will automatically use the first provider with a valid API key:

| Provider | API Key Variable | Get Your Key |
|----------|-----------------|--------------|
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/) |
| xAI (Grok) | `XAI_API_KEY` | [console.x.ai](https://console.x.ai/) |
| Google GenAI (Gemini) | `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| Groq | `GROQ_API_KEY` | [console.groq.com](https://console.groq.com/keys) |

## Quick Start

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Configure your API key**
   ```bash
   cp .env.example .env
   # Edit .env and add at least one API key
   ```

3. **Run the chat**
   ```bash
   bun run start
   ```

## Usage

```
🚀 Starting Eliza Chat...

✅ Using OpenAI for language model

💬 Chat with Eliza (type 'exit' to quit)

You: Hello!
Eliza: Hello! How can I help you today?

You: exit
👋 Goodbye!
```

## Provider Priority

If multiple API keys are set, the chat will use them in this order:

1. OpenAI
2. Anthropic (Claude)
3. xAI (Grok)
4. Google GenAI (Gemini)
5. Groq

## Model Customization

You can override the default models for each provider. See `.env.example` for all options.

### Examples

```bash
# Use GPT-4 Turbo instead of default
OPENAI_LARGE_MODEL=gpt-5

# Use Claude Opus
ANTHROPIC_LARGE_MODEL=claude-3-opus-20240229

# Use Llama 70B on Groq
GROQ_LARGE_MODEL=llama-3.3-70b-versatile
```

## Development

Run with hot reload:
```bash
bun run dev
```

## License

MIT
