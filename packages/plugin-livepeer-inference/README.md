# Livepeer Gateway LLM Plugin for ElizaOS

This ElizaOS plugin provides integration with Livepeer Gateway's LLM services, allowing your Eliza agents to use language models hosted on Livepeer's infrastructure.

## Features

- Connect to Livepeer Gateway for LLM inference
- Support for TEXT_SMALL, TEXT_LARGE, and TEXT_EMBEDDING model types
- Configurable model selection, temperature, and token limits
- Fallback embedding generation for compatibility with other plugins

## Configuration

The plugin requires the following environment variables:

| Variable               | Description                                                                   | Required | Default                                 |
| ---------------------- | ----------------------------------------------------------------------------- | -------- | --------------------------------------- |
| `LIVEPEER_GATEWAY_URL` | URL of the Livepeer Gateway API endpoint                                      | Yes      | -                                       |
| `LIVEPEER_API_KEY`     | API key for authenticating with Livepeer Gateway                              | No       | "eliza-app-llm"                         |
| `LIVEPEER_MODEL`       | Model to use for inference                                                    | No       | "meta-llama/Meta-Llama-3.1-8B-Instruct" |
| `LIVEPEER_LARGE_MODEL` | Alternative model for large text generation (overrides LIVEPEER_MODEL if set) | No       | -                                       |
| `LIVEPEER_TEMPERATURE` | Temperature for text generation (controls randomness)                         | No       | 0.6                                     |
| `LIVEPEER_MAX_TOKENS`  | Maximum tokens to generate in responses                                       | No       | 512 (TEXT_SMALL) / 2048 (TEXT_LARGE)    |

## Installation

1. Clone this repository to your Eliza project
2. Add the plugin to your character's plugin list:

```typescript
export const character: Character = {
  name: 'Your Character',
  plugins: [
    // Other plugins
    ...(process.env.LIVEPEER_GATEWAY_URL ? ['../path/to/plugin-livepeer'] : []),
  ],
  // Rest of your character configuration
};
```

3. Create a `.env` file with your Livepeer Gateway configuration (see example below)

## Example Usage

In your character configuration, conditionally include the Livepeer plugin:

```typescript
import { Character } from '@elizaos/core';

export const character: Character = {
  name: 'YourAgent',
  plugins: [
    // Other plugins
    ...(process.env.LIVEPEER_GATEWAY_URL ? ['../../plugin-livepeer'] : []),
  ],
  // Additional character configuration
};
```

The plugin will automatically register handlers for TEXT_SMALL, TEXT_LARGE, and TEXT_EMBEDDING model types when the LIVEPEER_GATEWAY_URL environment variable is present.

## Development

```bash
# Start development with hot-reloading
npm run dev

# Build the plugin
npm run build

# Test the plugin
npm run test
```

## Fallback Behavior

This plugin includes a simplified embedding implementation that provides deterministic embeddings when no sophisticated embedding model is available. This allows it to work with plugins that require embedding functionality while minimizing external dependencies.

## Troubleshooting

- If you encounter connection issues, verify your LIVEPEER_GATEWAY_URL and LIVEPEER_API_KEY are correct
- Check the logs for detailed error messages during inference
- Ensure the model specified is available on Livepeer Gateway
