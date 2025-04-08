# @elizaos/plugin-venice

Venice AI plugin for ElizaOS. This plugin provides integration with the Venice AI API for text generation and object generation capabilities.

## Configuration

The plugin requires the following environment variables to be set:

- `VENICE_API_KEY`: Your Venice AI API key
- `VENICE_SMALL_MODEL`: The model to use for small text generation (defaults to 'default')
- `VENICE_LARGE_MODEL`: The model to use for large text generation (defaults to 'default')
- `VENICE_EMBEDDING_MODEL`: The model to use for embeddings (optional)
- `VENICE_EMBEDDING_DIMENSIONS`: The dimensions for embeddings (optional)

## Features

- Text generation with both small and large models
- Object generation capabilities
- Automatic API key validation
- Configurable model selection
- Error handling and logging

## Usage

To use the Venice plugin, add it to your ElizaOS configuration:

```typescript
import { venicePlugin } from '@elizaos/plugin-venice';

// Add to your plugins array
const plugins = [
  venicePlugin,
  // ... other plugins
];
```

## Development

To build the plugin:

```bash
bun run build
```

To watch for changes during development:

```bash
bun run dev
```

## License

MIT 