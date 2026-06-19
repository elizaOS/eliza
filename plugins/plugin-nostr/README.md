# @elizaos/plugin-nostr

Nostr decentralized messaging plugin for elizaOS agents. Gives an Eliza agent a Nostr identity and connects it to one or more relays, enabling encrypted direct messages (NIP-04), public note publishing (kind:1), and profile management (kind:0).

## What it adds

- **Encrypted DMs (NIP-04)** — receive and send encrypted direct messages; routes through the `MESSAGE` connector action so the agent's planner needs no plugin-specific actions.
- **Public notes (kind:1)** — publish notes to connected relays; routes through the `POST` connector action. Supports relay feed reading and NIP-50 relay search where the relay implements it.
- **Profile publishing (kind:0)** — publish agent profile metadata (name, picture, nip05, etc.) to relays.
- **Multi-relay redundancy** — publishes to all configured relays; succeeds when at least one accepts the event.
- **Multi-account support** — run the agent under multiple Nostr identities simultaneously.

## Enabling the plugin

Add `@elizaos/plugin-nostr` to the `plugins` array in the agent character file, or let the auto-enable engine activate it automatically when a `connectors.nostr` block is present in the agent config.

```json
{
  "plugins": ["@elizaos/plugin-nostr"],
  "settings": {
    "NOSTR_PRIVATE_KEY": "your-private-key-hex-or-nsec",
    "NOSTR_RELAYS": "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band",
    "NOSTR_DM_POLICY": "pairing"
  }
}
```

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NOSTR_PRIVATE_KEY` | Yes | — | Private key in hex (64 chars) or `nsec1` bech32 format |
| `NOSTR_RELAYS` | No | damus.io, nos.lol, relay.nostr.band | Comma-separated relay WebSocket URLs |
| `NOSTR_DM_POLICY` | No | `pairing` | DM acceptance policy (see below) |
| `NOSTR_ALLOW_FROM` | No | — | Comma-separated pubkeys allowed to DM (required for `allowlist` policy) |
| `NOSTR_ENABLED` | No | `true` | Set to `false` to disable without removing config |
| `NOSTR_ACCOUNTS` | No | — | JSON array or object for multi-account configuration |
| `NOSTR_DEFAULT_ACCOUNT_ID` | No | `"default"` | Default account when multiple are configured |

### Character file override

Settings can be embedded directly in the character file under `settings.nostr`:

```json
{
  "settings": {
    "nostr": {
      "privateKey": "...",
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1...", "deadbeef..."],
      "profile": {
        "name": "my-agent",
        "nip05": "agent@example.com"
      }
    }
  }
}
```

For multiple accounts, use `settings.nostr.accounts`:

```json
{
  "settings": {
    "nostr": {
      "accounts": {
        "main": { "privateKey": "...", "relays": ["wss://relay.damus.io"] },
        "alt":  { "privateKey": "...", "relays": ["wss://nos.lol"] }
      }
    }
  }
}
```

## DM policies

| Policy | Description |
|---|---|
| `open` | Accept DMs from any pubkey |
| `pairing` | Accept DMs and remember senders |
| `allowlist` | Only accept DMs from pubkeys in `NOSTR_ALLOW_FROM` |
| `disabled` | Ignore all incoming DMs |

## Nostr concepts

- **Private key** — signs events and decrypts messages. Never commit to version control; use env vars or a secrets manager.
- **Public key** — derived automatically from the private key. This is the agent's Nostr identity.
- **npub / nsec** — bech32-encoded formats for public/private keys. Both formats are accepted as input.
- **kind:0** — profile metadata event.
- **kind:1** — public text note.
- **kind:4** — NIP-04 encrypted DM.

## Security

- Generate keys with a trusted tool such as `nostr-tools` (`generateSecretKey` + `getPublicKey`).
- Start with a restrictive DM policy (`allowlist`) and relax as needed.
- Consider running a private relay for sensitive agent deployments.

## Development

```bash
bun run --cwd plugins/plugin-nostr build
bun run --cwd plugins/plugin-nostr test
bun run --cwd plugins/plugin-nostr typecheck
```
