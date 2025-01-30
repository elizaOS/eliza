# @elizaos/plugin-autonome

A plugin that enables launching new Eliza agents through the [Autonome platform](https://dev.autonome.fun).

## Installation

```bash
pnpm add @elizaos/plugin-autonome
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

Add the plugin to your character's configuration:

```typescript
import { autonomePlugin } from "@elizaos/plugin-autonome";

const character = {
    plugins: [autonomePlugin]
};
```

## Features

- Launch new Eliza agents through the Autonome platform
- Configure agent settings via natural language
- Track deployment status
- Direct integration with Autonome dashboard

## Usage

The plugin responds to various deployment commands:

```plaintext
"Launch an agent, name is xiaohuo"
"Create a new agent"
"Deploy an Eliza agent"
```

Upon successful deployment, you'll receive a dashboard link:
```
https://dev.autonome.fun/autonome/[app-id]/details
```

## API Reference

### Actions

#### LAUNCH_AGENT
Creates and deploys a new agent to the Autonome platform.

Aliases:
- CREATE_AGENT
- DEPLOY_AGENT
- DEPLOY_ELIZA
- DEPLOY_BOT

Parameters:
- `name`: Name of the agent to deploy
- `config`: Agent configuration in JSON format

## Dependencies

- @coral-xyz/anchor: 0.30.1
- @elizaos/plugin-tee: workspace:*
- @elizaos/plugin-trustdb: workspace:*
- axios: ^1.7.9
