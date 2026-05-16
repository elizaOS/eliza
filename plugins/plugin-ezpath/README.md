# plugin-ezpath

Eliza plugin for [EZ-Path](https://ezpath.myezverse.xyz) — a pay-per-request DEX meta-router on Base mainnet. Fetches normalized swap quotes with automatic X402 USDC payment negotiation. No API key. No subscription. The agent pays per request.

## How payment negotiation works

```
Agent sends GET /api/v1/quote (no payment)
  └─► 402 Payment Required
        X-402-Address: 0x13dDE…  ← toll address
        Body: { tiers: { basic, resilient, institutional } }

Plugin reads toll address + tier pricing from 402 body
Plugin signs EIP-3009 TransferWithAuthorization (USDC on Base)
Agent retries with X-Payment: <base64-encoded-payload>
  └─► 200 OK  { price, buyAmount, routing_metadata, ... }
        X-Settlement-Tx: 0x...  ← on-chain confirmation
```

The agent never manages a subscription or API key. Every request is independently authorized. The signing wallet only needs USDC on Base — no pre-approval, no allowance.

## Execution tiers

| Tier | Authorization value | Routing logic |
|---|---|---|
| `basic` | 30,000 atomic (0.03 USDC) | Direct 0x execution |
| `resilient` | 100,000 atomic (0.10 USDC) | Concurrent race: 0x/ParaSwap vs Aerodrome on-chain read — highest `buyAmount` wins |
| `institutional` | 500,000 atomic (0.50 USDC) | Race + Uniswap V3 triple-fee-tier safety net if both lanes fail |

## Installation

```bash
npm install plugin-ezpath
# or
pnpm add plugin-ezpath
```

## Configuration

Add to your agent's character file or `.env`:

```env
EZPATH_WALLET_PRIVATE_KEY=0x<your-base-wallet-private-key>
EZPATH_TIER=basic   # optional — basic | resilient | institutional (default: basic)
```

The wallet must hold USDC on Base mainnet. A small amount of ETH is not required by the plugin itself, but the EZ-Path relayer settles the on-chain transfer on your behalf.

## Usage

```typescript
import { AgentRuntime } from "@elizaos/core";
import ezpathPlugin from "plugin-ezpath";

const runtime = new AgentRuntime({
  // ...
  plugins: [ezpathPlugin],
  settings: {
    EZPATH_WALLET_PRIVATE_KEY: process.env.EZPATH_WALLET_PRIVATE_KEY,
    EZPATH_TIER: "resilient",
  },
});
```

The `GET_SWAP_QUOTE` action activates on any message containing price/swap intent:

> *"What's the rate to swap 1 USDC for WETH on Base?"*
> *"Get me the best route for 1000000 USDC atoms → WETH, institutional tier"*
> *"Price check: sell 0x833589f... buy 0x420000..."*

## Direct API usage

The client is also exported for programmatic use outside Eliza:

```typescript
import { getQuote } from "plugin-ezpath";

const quote = await getQuote({
  sellToken:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  buyToken:   "0x4200000000000000000000000000000000000006", // WETH
  sellAmount: "1000000", // 1 USDC
  tier:       "resilient",
  privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
});

console.log(quote.price);            // "0.000449"
console.log(quote.routing_metadata); // { execution_mode, winner, race_comparison }
console.log(quote.settlement_tx);    // "0xa34cea..."
```

## Response shape

```typescript
interface QuoteResult {
  request_id:    string;
  sellToken:     string;
  buyToken:      string;
  sellAmount:    string;
  buyAmount:     string;             // base decimals
  price:         string;             // buyToken units per 1 sellToken, decimal-adjusted
  sources:       Array<{ name: string; proportion: string }>;
  routingEngine: string;
  tier:          "basic" | "resilient" | "institutional";
  routing_metadata: {
    execution_mode: "direct" | "concurrent_race" | "emergency_onchain_fallback";
    winner:         "0x" | "paraswap" | "aerodrome" | "uniswap_v3_onchain";
    race_comparison?: {
      lane_1_aggregator_out: string;
      lane_2_aerodrome_out:  string;
    };
  };
  settlement_tx?: string;  // on-chain tx hash when RELAYER_PRIVATE_KEY is set
}
```

## CDP AgentKit usage

```typescript
import { ezPathGetQuoteAction } from "plugin-ezpath";

// Wire into your AgentKit action registry
const result = await ezPathGetQuoteAction.func(
  {
    sellToken:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    buyToken:   "0x4200000000000000000000000000000000000006", // WETH
    sellAmount: "1000000",
    tier:       "resilient",
  },
  process.env.EZPATH_WALLET_PRIVATE_KEY!,
);
// "EZ-Path quote received.\ntier=resilient | winner=0x | mode=concurrent_race\n..."
```

The action reads the live toll address from the 402 probe, signs the EIP-3009 authorization internally, and retries — no pre-signed payload required from the calling agent.

## Links

- Live endpoint: https://ezpath.myezverse.xyz
- OpenAPI schema: https://ezpath.myezverse.xyz/openapi.json
- Agent manifest: https://ezpath.myezverse.xyz/.well-known/agent.json
- Contact: contact@ezsecuretech.com
