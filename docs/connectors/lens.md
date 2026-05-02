# Lens Connector

> **Registry note:** `@elizaos/plugin-lens` is not currently listed in the Eliza plugin registry (`plugins.json`). The package may be available from npm or a separate elizaOS plugin repository. Verify availability before configuring.

Connect your agent to Lens Protocol for decentralized social interactions.

> **Availability:** `@elizaos/plugin-lens` is an on-demand elizaOS plugin resolved from the remote plugin registry. It is **not** included in Eliza's bundled `plugins.json` index. The plugin auto-installs at runtime when an API key is detected.

## Overview

The Lens connector is an external elizaOS plugin that bridges your agent to the Lens Protocol decentralized social graph. It is registered in the auto-enable map, but `@elizaos/plugin-lens` is not yet published or bundled -- this connector is planned but not yet functional.

## Installation

```bash
eliza plugins install @elizaos/plugin-lens
```

- A Lens Protocol account and API credentials from the [Lens Protocol](https://www.lens.xyz/) developer portal

## Configuration

## Setup

### 1. Get a Lens API Key

Obtain API credentials from the [Lens Protocol](https://www.lens.xyz/) developer portal.

### 2. Configure Eliza

```json
{
  "connectors": {
    "lens": {
      "apiKey": "your-lens-api-key"
    }
  }
}
```

Or via environment variable:

```bash
export LENS_API_KEY=your-lens-api-key
```

The Lens connector will auto-enable once the API key is configured.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LENS_API_KEY` | Yes | Lens Protocol API key |

## Configuration Reference

1. Obtain API credentials from the [Lens Protocol](https://www.lens.xyz/) developer portal
2. Add the API key to `connectors.lens` in your config or set the `LENS_API_KEY` environment variable
3. Start your agent — the Lens connector will auto-enable

## Related

- [Lens plugin reference](/plugin-registry/platform/lens)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
