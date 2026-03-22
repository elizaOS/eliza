# @elizaos/plugin-safety-md

> Protect your Eliza agent from sending funds to malicious addresses.

This plugin adds a `CHECK_PAYMENT_ADDRESS` action that automatically verifies EVM wallet addresses against the [safety.md](https://safety.md) API before any payment is made.

## Features

- 🔍 Extracts `0x...` addresses from natural language messages
- 🛡️ Checks each address against safety.md's risk database
- ⚡ 3-second timeout with **fail-open** behavior (never blocks the agent)
- 🆓 Free tier: 10 checks/day, no API key required
- 📊 Returns risk level (`low` / `medium` / `high` / `critical`), reason, and on-chain signals

## Installation

```bash
pnpm add @elizaos/plugin-safety-md
```

## Usage

### Register in your character file

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-safety-md"],
  "...": "..."
}
```

### Register programmatically

```typescript
import { safetyMdPlugin } from "@elizaos/plugin-safety-md";
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  plugins: [safetyMdPlugin],
  // ...
});
```

## How it works

When a user message contains an Ethereum-format address (`0x` + 40 hex chars), the agent will:

1. Extract the address(es) from the message (up to 3 per message)
2. Call `https://safetymd.p-u-c.workers.dev/v1/check/{address}?chain=ethereum`
3. Reply with risk assessment, reason, and on-chain signals

### Example conversation

**User:** Can you send 0.1 ETH to `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`? Is it safe?

**Agent:**
```
✅ 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
Risk: LOW (SAFE)
Reason: No malicious signals detected. Address appears to be a known ENS-linked wallet.
```

---

**User:** Someone wants me to pay `0xbadActorAddress...` — should I trust it?

**Agent:**
```
🛑 0xbadActorAddress...
Risk: CRITICAL (UNSAFE)
Reason: Address linked to known rug-pull contracts.

🚫 Do not send funds to this address.
```

## Risk Levels

| Level | Emoji | Meaning |
|-------|-------|---------|
| `low` | ✅ | No known issues |
| `medium` | ⚠️ | Minor flags, proceed with caution |
| `high` | 🚨 | Significant risk, do not send |
| `critical` | 🛑 | Confirmed malicious, do not send |

## API

The plugin calls:
```
GET https://safetymd.p-u-c.workers.dev/v1/check/{address}?chain={chain}
```

Response shape:
```typescript
{
  safe: boolean;
  risk: "low" | "medium" | "high" | "critical";
  reason: string;
  service?: Record<string, unknown>;
  signals?: Record<string, unknown>;
}
```

No authentication required for the free tier (10 requests/day).

## Configuration

No environment variables required for the free tier.

For custom chain support, the plugin defaults to `chain=ethereum`. To check addresses on other chains, the API supports any EVM-compatible chain slug (e.g., `base`, `arbitrum`, `polygon`).

## License

MIT
