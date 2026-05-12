# Nostr Connector

Connect your agent to Nostr for relay-based social posting and conversations using the `@elizaos/plugin-nostr` package.

## Prerequisites

- A Nostr keypair (private key in nsec or hex format)

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `NOSTR_PRIVATE_KEY` | Yes | Private key (nsec or hex format) for signing events |
| `NOSTR_RELAYS` | No | Comma-separated list of relay URLs (e.g., `wss://relay.damus.io,wss://nos.lol`) |
| `NOSTR_DM_POLICY` | No | DM policy: `allow`, `deny`, or `allowlist` |
| `NOSTR_ALLOW_FROM` | No | Comma-separated list of allowed npub/hex public keys for DM allowlist |
| `NOSTR_ENABLED` | No | Explicitly enable or disable the connector |

The connector auto-enables when `token`, `botToken`, or `apiKey` is truthy in the connector config. Environment variables alone do not trigger auto-enable.

Nostr authenticates via the `NOSTR_PRIVATE_KEY` environment variable, not via a config-level token. Because the auto-enable system looks for `token`, `botToken`, or `apiKey` in the connector config, you have two options:

**Option 1 (recommended):** Add the plugin to `plugins.allow` explicitly — no placeholder needed:

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key_here"
  },
  "plugins": {
    "allow": ["@elizaos/plugin-nostr"]
  }
}
```

**Option 2:** Set a placeholder trigger field to activate auto-enable:

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key_here"
  },
  "connectors": {
    "nostr": {
      "token": "placeholder"
    }
  }
}
```

The `"token": "placeholder"` value is not used for authentication — it only triggers the auto-enable mechanism. The actual private key is always read from `NOSTR_PRIVATE_KEY`.

## Disabling

```json
{
  "connectors": {
    "nostr": {
      "enabled": false
    }
  }
}
```

## Setup

1. Generate a Nostr keypair if you don't have one (many Nostr clients can do this, or use tools like `nip06`).
2. Add the private key to your Eliza config under `env.NOSTR_PRIVATE_KEY`.
3. Optionally configure relay URLs. If none are specified, the plugin uses sensible defaults.
4. Start Eliza -- the plugin connects to relays and begins listening for messages.

## Features

- **Relay connectivity** -- Connect to multiple Nostr relays simultaneously
- **Note publishing** -- Post notes (kind 1 events) to the network
- **Direct messages** -- Handle NIP-04 encrypted direct messages
- **DM policies** -- Control who can send DMs with allow/deny/allowlist modes
- **Decentralized** -- No central server; the agent communicates via the Nostr relay network

## Related

- [Nostr plugin reference](/plugin-registry/platform/nostr)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
