# RedPill Plugin

This plugin provides integration with RedPill's model aggregator through the ElizaOS platform. Learn more about RedPill at https://red-pill.ai/

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-redpill"]
```

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "REDPILL_API_KEY": "your_redpill_api_key",
  "REDPILL_BASE_URL": "optional_custom_endpoint",
  "REDPILL_SMALL_MODEL": "openai/gpt-4o-mini",
  "REDPILL_LARGE_MODEL": "openai/gpt-4o"
}
```

Or in `.env` file:

```
REDPILL_API_KEY=your_redpill_api_key
# Optional overrides:
REDPILL_BASE_URL=optional_custom_endpoint
REDPILL_SMALL_MODEL=gpt-4o-mini
REDPILL_LARGE_MODEL=gpt-4o
```

### Configuration Options

- `REDPILL_API_KEY` (required): Your REDPILL API credentials
- `REDPILL_BASE_URL`: Custom API endpoint (default: https://api.red-pill.ai/v1)
- `REDPILL_SMALL_MODEL`: Defaults to GPT-4o Mini ("gpt-4o-mini")
- `REDPILL_LARGE_MODEL`: Defaults to GPT-4o ("gpt-4o")

The plugin provides these model classes:

- `TEXT_SMALL`: Optimized for fast, cost-effective responses
- `TEXT_LARGE`: For complex tasks requiring deeper reasoning
- `TEXT_EMBEDDING`: Text embedding model (text-embedding-3-small)
- `IMAGE_DESCRIPTION`: GPT-4o image analysis
- `TEXT_TOKENIZER_ENCODE`: Text tokenization
- `TEXT_TOKENIZER_DECODE`: Token decoding

## Additional Features

### Image Analysis

```js
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  'https://example.com/image.jpg'
);
```

### Text Embeddings

```js
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, 'text to embed');
```

## Resources

- [Website](https://red-pill.ai)
- [Docs](https://docs.red-pill.ai/)
- [Phala Cloud](https://cloud.phala.network)
