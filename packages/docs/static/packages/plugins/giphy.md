# Plugin Giphy

## Purpose

A plugin for sending GIFs in response to user messages.

## Key Features

Enables agent to respond with relevant GIFs based on user inputs using the Giphy API.

## Installation

```bash
bun add @elizaos/plugin-giphy
```

## Configuration

Set up your environment with a Giphy API key:

| Variable Name   | Description                               |
| --------------- | ----------------------------------------- |
| `GIPHY_API_KEY` | Giphy API key for authenticating requests |

## Integration

Provides the `SEND_GIF` action which automatically responds with a GIF based on the context of user messages.

## Example Usage

```typescript
import { giphyPlugin } from '@elizaos/plugin-giphy';

// Initialize the plugin
const plugin = giphyPlugin;

// Add the plugin to your agent's plugin list
const plugins = [
  giphyPlugin,
  // ... other plugins
];
```

## Links

[Giphy API](https://developers.giphy.com/)
[Giphy Developers](https://developers.giphy.com/)
