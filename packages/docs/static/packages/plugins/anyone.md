# @elizaos/plugin-anyone

## Purpose

A plugin for integrating Anyone protocol proxy services into Eliza agents.

## Key Features

- Start and stop Anyone client services
- Automatic proxy configuration for axios
- SOCKS proxy support (port 9050)
- Clean proxy cleanup and restoration

## Installation

```bash
bun add @elizaos/plugin-anyone
```

## Integration

The plugin provides two main services:

1. `AnyoneClientService`: Manages the Anyone client instance with singleton pattern implementation
2. `AnyoneProxyService`: Handles axios proxy configuration

## Example Usage

```typescript
import { anyonePlugin } from '@elizaos/plugin-anyone';

const character = {
  plugins: [anyonePlugin],
};
```

Available commands:

- START_ANYONE: "Can you start Anyone for me?"
- STOP_ANYONE: "Please shut down Anyone"
