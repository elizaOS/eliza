# @elizaos/plugin-allora

Seamlessly empowers Eliza agents with real-time, advanced, self-improving AI inferences from the Allora Network.

## Installation

```bash
pnpm add @elizaos/plugin-allora
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
import { alloraPlugin } from "@elizaos/plugin-allora";

const character = {
    plugins: [alloraPlugin],
    settings: {
        secrets: {
            ALLORA_API_KEY: "your_api_key"
        }
    }
};
```

## Features

- **Real-time Inference Access**: Get live predictions across various topics
- **Topic Management**: Automatic discovery and caching of available topics
- **Smart Caching**: 30-minute cache duration for optimal performance
- **Natural Language Interface**: Simple conversational commands for accessing predictions

## Usage

Users can request inferences using natural language:

```plaintext
"What is the predicted ETH price in 5 minutes?"
"Can you check the current BTC prediction?"
```

Example Response:
```plaintext
"Inference provided by Allora Network on topic ETH 5min (Topic ID: 13): 3393.364326646801085508"
```

## API Reference

### Actions

- `GET_INFERENCE`: Retrieves predictions for a specific topic
  - Aliases: `GET_ALLORA_INFERENCE`, `GET_TOPIC_INFERENCE`, `ALLORA_INFERENCE`, `TOPIC_INFERENCE`
  - Automatically matches user requests to available topics
  - Returns formatted inference results with topic details

### Providers

- `topicsProvider`: Manages topic information and caching
  - Provides context about available Allora Network topics
  - Implements 30-minute caching for optimization
  - Returns formatted topic information including names, descriptions, and status

## Troubleshooting

### Common Issues

1. "No active Allora Network topic matches your request"
   - Verify that your requested topic exists and is active
   - Check that the topic matches the timeframe of your request

2. API Connection Issues
   - Verify your ALLORA_API_KEY is correctly set
   - Check network connectivity
   - Ensure the API endpoint is accessible

For detailed information and additional implementation examples, please refer to the [Allora-Eliza integration docs](https://docs.allora.network/marketplace/integrations/eliza-os).
