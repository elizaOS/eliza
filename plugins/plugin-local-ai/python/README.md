# elizaOS Local AI Plugin (Python)

Python implementation of the Local AI plugin for elizaOS, providing local LLM inference using llama.cpp.

## Installation

```bash
pip install elizaos-plugin-local-ai
```

## Requirements

- Python 3.11+
- llama-cpp-python
- Model files (GGUF format)

## Usage

```python
from elizaos_plugin_local_ai import LocalAIPlugin, LocalAIConfig, TextGenerationParams

# Create configuration
config = LocalAIConfig(
    models_dir="/path/to/models",
    small_model="DeepHermes-3-Llama-3-3B-Preview-q4.gguf",
)

# Initialize plugin
plugin = LocalAIPlugin(config)

# Generate text
result = plugin.generate_text(TextGenerationParams(
    prompt="Tell me a joke",
    max_tokens=100,
))

print(result.text)
```

## Configuration

Environment variables:

- `MODELS_DIR`: Directory containing model files
- `CACHE_DIR`: Directory for caching
- `LOCAL_SMALL_MODEL`: Filename of small model
- `LOCAL_LARGE_MODEL`: Filename of large model
- `LOCAL_EMBEDDING_MODEL`: Filename of embedding model
- `LOCAL_EMBEDDING_DIMENSIONS`: Embedding vector dimensions (default: 384)

## License

MIT



