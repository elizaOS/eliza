# @elizaos/plugin-feedo

Decentralized E2EE long-term memory for ElizaOS using the Feedo Protocol.

## Installation

```bash
npm install @elizaos/plugin-feedo
```

## Configuration

Set the following environment variables:

```env
FEEDO_USAGE_KEY=0x...
FEEDO_AGENT_DID=did:feedo:...
```

## Usage

Register the plugin in your ElizaOS character or runtime configuration:

```typescript
import { feedoPlugin } from "@elizaos/plugin-feedo";

export default {
    plugins: [feedoPlugin],
    // ...
};
```

## Features

- **Decentralized Storage**: Save and retrieve memories from the Feedo network.
- **E2EE**: Fully encrypted end-to-end.
- **Provider**: Automatically injects relevant memories into the agent context.
