---
title: "Lens Plugin"
sidebarTitle: "Lens"
description: "The @elizaos/plugin-lens package is not currently available in the Eliza plugin registry."
---

> **Registry note:** `@elizaos/plugin-lens` is not currently listed in the Eliza plugin registry (`plugins.json`). The package may be available from npm or a separate elizaOS plugin repository. Verify availability before configuring.

The Lens plugin connects Eliza agents to the Lens Protocol, enabling social interactions on the decentralized social graph built on Polygon.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-lens`

## Installation

```bash
# Requires the package to be available on npm
eliza plugins install lens
```

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

Or use environment variables:

```bash
export LENS_API_KEY=your-lens-api-key
```

## Enabling

After installation, the plugin loads when `apiKey` is present in the connector config. Unlike bundled connectors, it does not auto-enable from config alone — it must be installed first.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `apiKey` | Yes | Lens Protocol API key |

## Features

- Lens Protocol social interactions
- Post publishing and engagement
- Profile-based social graph traversal
- Decentralized content on Polygon

## Related

- [Farcaster Plugin](/plugin-registry/platform/farcaster) — Decentralized social connector
- [Nostr Plugin](/plugin-registry/platform/nostr) ��� Relay-based decentralized social
- [Connectors Guide](/guides/connectors) — Full connector reference
