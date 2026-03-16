# elizaos-plugin-groq

Python implementation of the Groq LLM plugin for elizaOS.

## Features

- 🐍 **Pythonic API** - Clean, intuitive async interface
- 📦 **Type hints** - Full typing with Pydantic models
- 🔄 **Auto-retry** - Automatic rate limit and error handling
- 🧪 **Well tested** - Comprehensive test coverage

## Installation

```bash
pip install elizaos-plugin-groq
```

For development:

```bash
pip install elizaos-plugin-groq[dev]
```

## Usage

### Basic Text Generation

```python
import asyncio
from elizaos_plugin_groq import GroqClient, GenerateTextParams

async def main():
    async with GroqClient(api_key="your-api-key") as client:
        # Generate text with the large model
        response = await client.generate_text_large(
            GenerateTextParams(
                prompt="Explain quantum computing in simple terms.",
                temperature=0.7,
                max_tokens=1024,
            )
        )
        print(response)

asyncio.run(main())
```

### Audio Transcription

```python
from elizaos_plugin_groq import GroqClient, TranscriptionParams

async def transcribe_audio(audio_data: bytes) -> str:
    async with GroqClient(api_key="your-api-key") as client:
        text = await client.transcribe(
            TranscriptionParams(
                audio=audio_data,
                format="mp3",
            )
        )
        return text
```

### Text-to-Speech

```python
from elizaos_plugin_groq import GroqClient, TextToSpeechParams

async def generate_speech(text: str) -> bytes:
    async with GroqClient(api_key="your-api-key") as client:
        audio = await client.text_to_speech(
            TextToSpeechParams(text=text)
        )
        return audio
```

### JSON Object Generation

```python
from elizaos_plugin_groq import GroqClient, GenerateObjectParams

async def generate_json() -> dict:
    async with GroqClient(api_key="your-api-key") as client:
        obj = await client.generate_object(
            GenerateObjectParams(
                prompt="Generate a user profile with name, age, and hobbies",
                temperature=0.7,
            )
        )
        return obj
```

## Configuration

Create a client with custom configuration:

```python
from elizaos_plugin_groq import GroqClient, GroqConfig

config = GroqConfig(
    api_key="your-api-key",
    base_url="https://api.groq.com/openai/v1",
    small_model="llama-3.1-8b-instant",
    large_model="llama-3.3-70b-versatile",
    tts_model="playai-tts",
    tts_voice="Chip-PlayAI",
    transcription_model="distil-whisper-large-v3-en",
)

client = GroqClient(api_key="", config=config)
```

## Error Handling

The package provides typed exceptions:

```python
from elizaos_plugin_groq import GroqClient, GroqError, GroqErrorCode

async def safe_generate():
    async with GroqClient(api_key="your-api-key") as client:
        try:
            response = await client.generate_text_large(params)
            return response
        except GroqError as e:
            if e.code == GroqErrorCode.RATE_LIMIT_EXCEEDED:
                print(f"Rate limited, retry after {e.retry_after}s")
            elif e.code == GroqErrorCode.INVALID_API_KEY:
                print("Invalid API key")
            elif e.is_retryable:
                print(f"Retryable error: {e}")
            raise
```

## elizaOS Integration

Use the plugin with elizaOS:

```python
from elizaos_plugin_groq import get_plugin

# Get the plugin definition
plugin = get_plugin()
print(f"Plugin: {plugin['name']} v{plugin['version']}")
```

## Development

```bash
# Clone and install dev dependencies
git clone https://github.com/elizaos-plugins/plugin-groq.git
cd plugin-groq/python
pip install -e ".[dev]"

# Run tests
pytest

# Run linting
ruff check .
ruff format .

# Run type checking
mypy elizaos_plugin_groq
```

## Requirements

- Python >= 3.11
- httpx >= 0.28.0
- pydantic >= 2.10.0
- tiktoken >= 0.8.0

## License

MIT License
