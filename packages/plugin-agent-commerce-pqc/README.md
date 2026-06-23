# @elizaos/plugin-agent-commerce

Quantum-resistant secure agent commerce for ElizaOS: ERC-8183 escrow, ML-KEM-768 transport, tamper-evident audit logs, and prompt-injection protection in one plugin.

## Install

```bash
npm install @elizaos/plugin-agent-commerce
# or
bun add @elizaos/plugin-agent-commerce
```

## Register Plugin

```typescript
import { agentCommercePlugin } from '@elizaos/plugin-agent-commerce';

const character = {
  name: 'SecureCommerceAgent',
  plugins: ['@elizaos/plugin-agent-commerce'],
  settings: {
    STVOR_RELAY_URL: 'wss://<your-railway-url>',
    STVOR_APP_TOKEN: '<your-railway-token>',
    STVOR_STRICT_MODE: 'true',
    STVOR_ALLOW_MOCK: 'false'
  }
};
```

## Security Model

### Why Post-Quantum Cryptography is Necessary for Agents

Agents process sensitive data including API keys, credentials, and private information. Classical encryption (RSA, ECC) is vulnerable to future quantum computers. ML-KEM-768 provides quantum-resistant key encapsulation that protects against "harvest now, decrypt later" attacks.

### How SecurityGuard Works

**Strict Mode (`STVOR_STRICT_MODE=true`)**
- Blocks all non-PQC encrypted messages
- Requires `content.pqcEncrypted === true`
- Throws error with `[SECURITY-GUARD]` prefix if validation fails

**Non-Strict Mode**
- Logs warnings for non-PQC messages
- Allows messages through but warns developers
- Recommended only for development

### Deploy Secure Transport via Railway

1. Set environment variables:
   ```bash
   STVOR_RELAY_URL=wss://your-relay.up.railway.app
   STVOR_APP_TOKEN=your-token
   STVOR_STRICT_MODE=true
   ```

2. Deploy relay server:
   ```bash
   bun start:relay
   ```

3. Verify health:
   ```bash
   curl http://localhost:4444/health
   ```

## Actions

| Action | Description |
|--------|-------------|
| `CREATE_SECURE_JOB` | Create a new ERC-8183 job with PQC-secured transport |
| `FUND_SECURE_JOB` | Fund a job and trigger encrypted task delivery |
| `SUBMIT_DELIVERABLE` | Submit encrypted deliverable for a funded job |
| `JOB_STATUS` | Check the status of an ERC-8183 commerce job |

## Evaluators

| Evaluator | Description |
|-----------|-------------|
| `SECURITY_GUARD` | Enforces ML-KEM-768/PQC encrypted transport |
| `COMMERCE_TRACKER` | Extracts and tracks job IDs from conversation |

## Provider

- `COMMERCE_CONTEXT` - Provides active ERC-8183 job context and crypto transport status

## Development

```bash
bun install
bun test
bun run type-check
bun --cwd packages/plugin-agent-commerce build
```