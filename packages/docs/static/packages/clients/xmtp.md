# XMTP Client package

## Purpose

The XMTP client enables secure, decentralized, and encrypted messaging integration with ElizaOS.

## Key Features

- End-to-end encryption and regulatory compliance
- Open-source and trustless (built on MLS protocol)
- Privacy and metadata protection
- Decentralized peer-to-peer network
- Multi-tenant communication support

## Installation

```bash
bun add @elizaos/client-xmtp
```

## Configuration

```tsx
// Configuration in .env
WALLET_KEY= // the private key of the wallet
ENCRYPTION_KEY= // a second random 32 bytes encryption key for local db encryption
```

## Integration

```tsx
import { XmtpClientInterface } from '@elizaos/client-xmtp';

// Initialize the XMTP client
const client = await XmtpClientInterface.start(runtime);
```

## Links

- [Agent examples repo](https://github.com/ephemeraHQ/xmtp-agent-examples)
- [XMTP FAQ](https://docs.xmtp.org/intro/faq)
- [Web inbox](https://xmtp.chat)
