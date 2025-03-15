# Plugin Giphy

A plugin for sending GIFs in response to user messages.

## Overview

The **Plugin Giphy** enhances your agent's interactions by enabling it to respond with relevant GIFs based on user inputs. Leveraging the [Giphy API](https://developers.giphy.com/), this plugin detects specific triggers in user messages and responds with appropriate GIFs to make conversations more engaging and expressive.

## Installation

```bash
pnpm add @elizaos/plugin-giphy
```

## Configuration

Set up your environment with the required Giphy API key:

| Variable Name | Description |
|--------------|-------------|
| `GIPHY_API_KEY` | Giphy API key for authenticating requests |

You need to obtain an API key by signing up at [Giphy Developers](https://developers.giphy.com/).

## Usage

```typescript
import { giphyPlugin } from "@elizaos/plugin-giphy";

// Initialize the plugin
const plugin = giphyPlugin;

// Add the plugin to your agent's plugin list
const plugins = [
  giphyPlugin,
  // ... other plugins
];

// Initialize your agent with the plugins
// Example:
// const agent = new Agent({ plugins, ...otherConfig });
```

The plugin provides the `SEND_GIF` action, which automatically responds with a GIF based on the context of user messages. No additional setup is required beyond installing and configuring the plugin.

## License

MIT
