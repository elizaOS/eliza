# @elizaos/plugin-autonome

## Purpose

A plugin that enables launching new Eliza agents through the Autonome platform.

## Installation

```bash
bun add @elizaos/plugin-autonome
```

## Configuration

### Environment Variables

```env
# Required: JWT token from Autonome platform
AUTONOME_JWT_TOKEN=your_jwt_token

# Required: Autonome RPC endpoint (fixed production endpoint)
AUTONOME_RPC=https://wizard-bff-rpc.alt.technology/v1/bff/aaa/apps
```

To get your JWT token:

1. Login to [dev.autonome.fun](https://dev.autonome.fun)
2. Open browser developer console
3. Extract your JWT token

### Character Configuration

```typescript
import { autonomePlugin } from '@elizaos/plugin-autonome';

const character = {
  plugins: [autonomePlugin],
};
```

## Key Features

- Launch new Eliza agents through the Autonome platform
- Configure agent settings via natural language
- Track deployment status
- Direct integration with Autonome dashboard

## Example Usage

The plugin responds to deployment commands like:

```plaintext
"Launch an agent, name is xiaohuo"
"Create a new agent"
"Deploy an Eliza agent"
```

## Links

[Autonome platform](https://dev.autonome.fun)
