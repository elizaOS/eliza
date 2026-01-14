# @elizaos/plugin-trajectory-logger

Trajectory logger plugin for ElizaOS.

This plugin captures rich agent interaction trajectories and provides utilities to:

- Wrap actions/providers with logging hooks
- Record LLM calls, provider accesses, and action attempts
- Convert trajectories to ART-compatible message format (OpenPipe ART / GRPO)

## Install

```bash
npm install @elizaos/plugin-trajectory-logger
```

## Usage

```ts
import { trajectoryLoggerPlugin } from "@elizaos/plugin-trajectory-logger";

export const character = {
  plugins: [trajectoryLoggerPlugin],
};
```

