# @elizaos/plugin-allora

## Purpose

Seamlessly empowers Eliza agents with real-time, advanced, self-improving AI inferences from the Allora Network.

## Installation

```bash
bun add @elizaos/plugin-allora
```

## Configuration

### Environment Variables

```env
ALLORA_API_KEY=your_api_key          # Required: Allora API key
ALLORA_CHAIN_SLUG=testnet            # Optional: Defaults to testnet
```

### Character Configuration

Add the plugin to your character's configuration:

```typescript
import { alloraPlugin } from '@elizaos/plugin-allora';

const character = {
  plugins: [alloraPlugin],
  settings: {
    secrets: {
      ALLORA_API_KEY: 'your_api_key',
    },
  },
};
```

## Key Features

- **Real-time Inference Access**: Get live predictions across various topics
- **Topic Management**: Automatic discovery and caching of available topics
- **Smart Caching**: 30-minute cache duration for optimal performance
- **Natural Language Interface**: Simple conversational commands for accessing predictions

## Example Usage

Users can request inferences using natural language:

```plaintext
"What is the predicted ETH price in 5 minutes?"
"Can you check the current BTC prediction?"
```

Example Response:

```plaintext
"Inference provided by Allora Network on topic ETH 5min (Topic ID: 13): 3393.364326646801085508"
```

## Links

[Allora-Eliza integration docs](https://docs.allora.network/marketplace/integrations/eliza-os/implementation)
