# @elizaos/plugin-x402

x402 micropayment middleware for elizaOS plugin HTTP routes.

This package lets Eliza agent plugins gate their HTTP routes behind the [x402 protocol](https://x402.org), requiring on-chain micropayments before serving responses. It handles HTTP 402 negotiation, payment verification (on-chain and facilitator-backed), and replay protection in one integration point.

## What it does

- **Declares payment requirements** via HTTP 402 responses with `accepts` arrays describing payment networks, token addresses, amounts, and resource URLs — compatible with x402scan indexing.
- **Verifies payments** using three strategies, tried in priority order:
  1. Standard `X-Payment` / `PAYMENT-SIGNATURE` payloads (x402-fetch / CDP-style) verified and settled via a facilitator.
  2. Direct on-chain proofs: Solana SPL token transfers (via `@solana/web3.js`), EVM ERC-20 transfers and EIP-712 authorizations (via `viem`).
  3. Facilitator payment IDs via `X-Payment-Id` header.
- **Prevents replay attacks** using an atomic in-process guard plus a durable store backed by `runtime.setCache`/`getCache` (shared across processes when using the same DB).
- **Emits runtime events** on payment required (`PAYMENT_REQUIRED`) and verified (`PAYMENT_VERIFIED`).

## Supported networks and tokens

| Config name | Network | Token |
|-------------|---------|-------|
| `base_usdc` | Base (chain 8453) | USDC |
| `solana_usdc` | Solana | USDC |
| `polygon_usdc` | Polygon (chain 137) | USDC |
| `bsc_usdc` | BSC (chain 56) | USDC |
| `base_elizaos` | Base | elizaOS token |
| `solana_elizaos` | Solana | elizaOS token |
| `solana_degenai` | Solana | degenai |

## Enabling in a plugin

Install (it is a peer dependency of `@elizaos/core` in this monorepo):

```bash
bun add @elizaos/plugin-x402
```

Wrap your route array before returning them from your plugin:

```typescript
import { applyPaymentProtection } from '@elizaos/plugin-x402';
import type { Plugin, Route } from '@elizaos/core';

const routes: Route[] = applyPaymentProtection([
  {
    type: 'GET',
    path: '/api/premium-data',
    public: true,
    x402: {
      priceInCents: 10,                             // $0.10
      paymentConfigs: ['base_usdc', 'solana_usdc'],
    },
    handler: async (req, res, runtime) => {
      res.json({ result: 'premium content' });
    },
  },
]);

export const myPlugin: Plugin = { name: 'my-plugin', routes };
```

`applyPaymentProtection` validates config at call time and throws on misconfiguration so the agent fails fast at startup.

## Shorthand with character defaults

Set `x402: true` on a route to inherit price and payment configs from the agent character:

```typescript
// In character config:
character.settings.x402 = {
  defaultPriceInCents: 10,
  defaultPaymentConfigs: ['base_usdc', 'solana_usdc'],
};

// In route:
{ type: 'GET', path: '/api/resource', x402: true, handler: ... }
```

## Required environment variables

Set your payout wallet addresses. If unset, bundled example addresses are used (startup warns in dev, errors in production).

```
# Payout wallets (set the networks you want to accept)
SOLANA_PUBLIC_KEY=<your-solana-wallet>
BASE_PUBLIC_KEY=<your-base-evm-wallet>
POLYGON_PUBLIC_KEY=<your-polygon-evm-wallet>
BSC_PUBLIC_KEY=<your-bsc-evm-wallet>
```

## Optional environment variables

```
# Facilitator service (recommended for standard x402-fetch clients)
X402_FACILITATOR_URL=https://your-facilitator.example.com

# Override individual facilitator endpoints
X402_FACILITATOR_VERIFY_URL=https://your-facilitator.example.com/api/v1/x402/verify
X402_FACILITATOR_SETTLE_URL=https://your-facilitator.example.com/api/v1/x402/settle

# Public base URL for this server (used in resource URLs)
X402_BASE_URL=https://your-agent.example.com

# Development: skip all payment verification
X402_TEST_MODE=true

# Replay protection: use in-memory only (no DB persistence)
X402_REPLAY_DURABLE=0

# Custom RPC endpoints
SOLANA_RPC_URL=https://your-rpc.solana.com
BASE_RPC_URL=https://your-rpc.base.org

# Token prices for non-stablecoin configs (exact decimal string, dollars)
ELIZAOS_PRICE_USD=0.05
AI16Z_PRICE_USD=0.50
DEGENAI_PRICE_USD=0.01

# Debug logging
DEBUG_X402_PAYMENTS=true
```

## Custom payment configs

Register additional token/network combinations at plugin init time:

```typescript
import { registerX402Config } from '@elizaos/plugin-x402';

registerX402Config('mytoken_base', {
  network: 'BASE',
  assetNamespace: 'erc20',
  assetReference: '0x<token-contract-address>',
  paymentAddress: process.env.BASE_PUBLIC_KEY!,
  symbol: 'MYTOKEN',
  chainId: '8453',
});
```

Then reference `'mytoken_base'` in your route's `paymentConfigs` array.

## Payment headers

Clients send payment credentials in HTTP headers:

| Header | Purpose |
|--------|---------|
| `X-Payment` or `PAYMENT-SIGNATURE` | Standard x402 payload (base64 JSON with `x402Version`, `accepted`, `payload`) |
| `X-Payment-Proof` | Legacy proof: Solana tx sig, EVM tx hash, or colon-delimited format |
| `X-Payment-Id` | Facilitator-issued payment ID |

On success the response includes a `PAYMENT-RESPONSE` header from the facilitator and emits a `PAYMENT_VERIFIED` event on the agent runtime.
