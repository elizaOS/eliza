# @elizaos/plugin-hyperd

> First-party elizaOS plugin for [hyperD](https://hyperd.ai) — on-demand DeFi intelligence (wallet risk, token security, liquidation alerts, P&L, DEX quotes) paid per-call in USDC on Base via the x402 protocol. **No API key. No signup.**

## Actions

| Action | Description | Cost |
|---|---|---|
| `HYPERD_WALLET_RISK` | Chainalysis Sanctions Oracle + GoPlus heuristics. "Is this address safe to interact with." | $0.10 |
| `HYPERD_TOKEN_SECURITY` | GoPlus security score 0–100. Honeypot detection, owner permissions, taxes, holder concentration. | $0.05 |
| `HYPERD_LIQUIDATION_RISK` | Cross-protocol composite health factor across Aave V3 / Compound v3 / Spark / Morpho. | $0.10 |
| `HYPERD_WALLET_PNL` | Realized + unrealized P&L over a configurable window. Per-token breakdown with mark-to-market. | $0.05 |
| `HYPERD_DEX_QUOTE` | Best swap route aggregated across Paraswap + 0x. Highest output + per-source breakdown. | $0.02 |

**Total to call all five once: $0.32.** Every agent decision cycle costs less than a third of a cent.

The plugin handles the x402 payment flow transparently. Your agent signs EIP-3009 USDC transfer authorizations on Base; Coinbase's facilitator settles in ~2 seconds. There is no key store to rotate, no rate-limit form to fill, no signup.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `HYPERD_BUYER_PRIVATE_KEY` | **Yes** | — | 0x-prefixed 32-byte hex EVM private key. The wallet must hold USDC on Base. |
| `HYPERD_API_BASE` | No | `https://api.hyperd.ai` | Override only for self-hosted or testing. |
| `HYPERD_MAX_USDC_PER_CALL` | No | `0.25` | Refuses calls priced above this cap. |

~$5 USDC on Base is plenty for hundreds of agent decision cycles.

## Usage

```ts
import hyperdPlugin from "@elizaos/plugin-hyperd";

const agent = createAgent({
    plugins: [hyperdPlugin],
    // ...
});
```

That's it. The five actions become available; the LLM picks the right one based on what the user asks.

## How the x402 payment works

The plugin wraps `globalThis.fetch` with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch). Each request that returns 402 Payment Required carries machine-readable payment terms in the response header. The plugin signs an EIP-3009 USDC transfer authorization on Base, retries with an `X-Payment` header, and Coinbase's x402 facilitator settles the transfer in ~2 seconds.

## Links

- **API**: [api.hyperd.ai](https://api.hyperd.ai)
- **Discover (Bazaar format)**: [api.hyperd.ai/api/discover](https://api.hyperd.ai/api/discover)
- **MCP server**: [`hyperd-mcp`](https://www.npmjs.com/package/hyperd-mcp) — `npx -y hyperd-mcp`
- **Source mirror (MIT)**: [github.com/hyperd-ai/hyperd-mcp](https://github.com/hyperd-ai/hyperd-mcp)
- **x402 protocol**: [x402.org](https://x402.org)
