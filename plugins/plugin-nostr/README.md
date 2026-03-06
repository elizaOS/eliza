# @elizaos/plugin-nostr

Nostr decentralized messaging plugin for elizaOS agents. Enables secure, encrypted direct messaging (NIP-04) over the Nostr protocol.

## Features

- **Encrypted Direct Messages (NIP-04)**: Send and receive encrypted DMs using the Nostr protocol
- **Multi-relay Support**: Connect to multiple Nostr relays for redundancy
- **Profile Management**: Publish and update your agent's Nostr profile (kind:0)
- **DM Policy Control**: Configure who can message your agent (open, pairing, allowlist, disabled)
- **Multi-language Support**: Available in TypeScript, Python, and Rust

## Installation

```bash
# npm
npm install @elizaos/plugin-nostr

# pnpm
pnpm add @elizaos/plugin-nostr
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NOSTR_PRIVATE_KEY` | Private key (hex or nsec format) | Yes |
| `NOSTR_RELAYS` | Comma-separated relay URLs | No |
| `NOSTR_DM_POLICY` | DM policy: open, pairing, allowlist, disabled | No |
| `NOSTR_ALLOW_FROM` | Comma-separated pubkeys for allowlist | No |
| `NOSTR_ENABLED` | Enable/disable the plugin | No |

### Agent Configuration

```json
{
  "plugins": ["@elizaos/plugin-nostr"],
  "pluginParameters": {
    "NOSTR_PRIVATE_KEY": "your-private-key-hex-or-nsec",
    "NOSTR_RELAYS": "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band",
    "NOSTR_DM_POLICY": "pairing"
  }
}
```

## Usage

### Actions

#### NOSTR_SEND_DM

Send an encrypted direct message to a Nostr pubkey.

```
"Send them a message saying 'Hello!'"
"Message npub1abc... saying 'Thanks for the zap!'"
```

#### NOSTR_PUBLISH_PROFILE

Update the agent's Nostr profile.

```
"Update your profile name to 'Bot Assistant'"
"Set your bio to 'I am an AI assistant on Nostr'"
```

### Providers

#### nostrIdentityContext

Provides information about the bot's Nostr identity:
- Public key (hex and npub)
- Connected relays
- Connection status

#### nostrSenderContext

Provides information about the current conversation partner:
- Sender's pubkey (hex and npub)
- Display name
- Encryption status

## DM Policies

| Policy | Description |
|--------|-------------|
| `open` | Accept DMs from anyone |
| `pairing` | Accept DMs and remember senders for future conversations |
| `allowlist` | Only accept DMs from pubkeys in NOSTR_ALLOW_FROM |
| `disabled` | Don't accept any DMs |

## Nostr Concepts

### Keys

- **Private Key**: Used to sign events and decrypt messages. Keep this secret!
- **Public Key**: Your identity on Nostr. Can be shared freely.
- **npub/nsec**: Bech32-encoded formats for public/private keys

### Events

- **kind:0**: Profile metadata
- **kind:4**: Encrypted DMs (NIP-04)

### Relays

Nostr relays are servers that store and forward events. Your agent connects to multiple relays for redundancy.

## Example

```typescript
import { createAgent } from "@elizaos/core";
import nostrPlugin from "@elizaos/plugin-nostr";

const agent = await createAgent({
  plugins: [nostrPlugin],
  settings: {
    NOSTR_PRIVATE_KEY: process.env.NOSTR_PRIVATE_KEY,
    NOSTR_RELAYS: "wss://relay.damus.io,wss://nos.lol",
    NOSTR_DM_POLICY: "pairing",
  },
});

// The agent can now receive DMs and respond
```

## Security Considerations

1. **Private Key Storage**: Never commit your private key to version control. Use environment variables or secure secret management.

2. **Key Generation**: Generate keys using a reputable tool like `nip-06` or the `nostr-tools` library.

3. **Relay Selection**: Choose relays carefully. Consider running your own relay for sensitive applications.

4. **DM Policy**: Start with a restrictive policy and relax as needed.

## Development

### Building

```bash
# TypeScript
cd typescript && npm run build

# Python
cd python && pip install -e .

# Rust
cd rust && cargo build
```

### Testing

```bash
# TypeScript
npm test

# Python
pytest

# Rust
cargo test
```

## API Reference

### NostrService

#### Methods

- `isConnected()`: Check if connected to relays
- `getPublicKey()`: Get the bot's public key (hex)
- `getNpub()`: Get the bot's npub
- `getRelays()`: Get connected relay URLs
- `sendDm(options)`: Send an encrypted DM
- `publishProfile(profile)`: Publish profile metadata

### Types

```typescript
interface NostrSettings {
  privateKey: string;
  publicKey: string;
  relays: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  enabled: boolean;
}

interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
}

interface NostrDmSendOptions {
  toPubkey: string;
  text: string;
}

interface NostrSendResult {
  success: boolean;
  eventId?: string;
  relays: string[];
  error?: string;
}
```

## License

MIT
