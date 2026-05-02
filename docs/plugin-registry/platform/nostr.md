---
title: "Nostr Plugin"
sidebarTitle: "Nostr"
description: "Nostr connector for Eliza — relay-based social posting and encrypted direct messages."
---

The Nostr plugin connects Eliza agents to the Nostr network, enabling note publishing, relay connectivity, and NIP-04 encrypted direct messages.

**Package:** `@elizaos/plugin-nostr`

## Installation

```bash
eliza plugins install @elizaos/plugin-nostr
```

## Setup

### 1. Generate a Keypair

Use any Nostr client or key generation tool to create a keypair. You need the private key (nsec or hex format).

### 2. Configure Eliza

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key"
  },
  "connectors": {
    "nostr": {
      "enabled": true
    }
  }
}
```

### 3. (Optional) Configure Relays

```json
{
  "env": {
    "NOSTR_RELAYS": "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band"
  }
}
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NOSTR_PRIVATE_KEY` | Yes | — | Private key for signing events (nsec or hex) |
| `NOSTR_RELAYS` | No | — | Comma-separated relay URLs |
| `NOSTR_DM_POLICY` | No | — | DM policy: `allow`, `deny`, or `allowlist` |
| `NOSTR_ALLOW_FROM` | No | — | Comma-separated allowed public keys |
| `NOSTR_ENABLED` | No | `true` | Enable or disable the connector |

## Features

- Multi-relay connectivity
- Note publishing (kind 1 events)
- NIP-04 encrypted direct messages
- DM access policies (allow, deny, allowlist)
- Decentralized — no central server

## Auto-Enable

The plugin auto-enables when the `connectors.nostr` block contains `token`, `botToken`, or `apiKey`. Environment variables alone do not trigger auto-enable. To use env-based config with auto-enable, include `"token": "placeholder"` in the connector config, or add the plugin to `plugins.allow` explicitly.

## Related

- [Nostr connector setup](/connectors/nostr) — full connector configuration
- [Connectors overview](/guides/connectors) — all platform connectors
