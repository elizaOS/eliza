# @elizaos/plugin-dflow-trade

Official elizaOS plugin for **natural-language Solana spot trading** via [DFlow](https://pond.dflow.net) + Helius.

Works with **DeepSeek** (`DEEPSEEK_API_KEY`) or any other model provider — this plugin supplies **actions + context**, not the LLM itself.

## Env

| Variable | Required | Purpose |
| --- | --- | --- |
| `DFLOW_API_KEY` | prod | `x-api-key` for `https://quote-api.dflow.net` |
| `HELIUS_RPC_URL` / `SOLANA_RPC_URL` | live + balance | Broadcast / SOL balance |
| `SOLANA_PRIVATE_KEY` | live | Base58 keypair |
| `SOLANA_TRADE_LIVE` | live | Must be `true` to sign+send |
| `DEEPSEEK_API_KEY` | optional | LLM (or use OpenAI/Anthropic/etc.) |
| `DFLOW_TRADE_API_URL` | optional | Override API host |
| `DFLOW_SLIPPAGE_BPS` | optional | Default `auto` |

Dev host (no key): `https://dev-quote-api.dflow.net`  
Prod host (key): `https://quote-api.dflow.net`

## Actions

| Action | Behavior |
| --- | --- |
| `DFLOW_QUOTE` | `GET /order` quote (optional wallet for tx attachment) |
| `DFLOW_SWAP` | Preview by default; **live** only if user says execute/live **and** `SOLANA_TRADE_LIVE=true` |
| `DFLOW_TRADE_STATUS` | Readiness + optional SOL balance |

## Provider

`DFLOW_TRADE_CONTEXT` — injects readiness + NL usage so the model “knows” it can trade.

## Examples

```
Quote 0.01 SOL to USDC
Swap 1 USDC to SOL preview
Execute swap 0.01 SOL to USDC live
Can I trade? Show trade readiness and balance
```

## Safety

- **Preview-first** — no broadcast without live flag + explicit language.
- Never invent signatures; live path returns Solscan URL.
- Atomic units handled for known symbols (SOL, USDC, USDT, JUP, BONK, …).

## Install

```ts
import dflowTradePlugin from "@elizaos/plugin-dflow-trade";

const character = {
  name: "Clawd",
  plugins: [dflowTradePlugin],
};
```

Optional live deps:

```bash
bun add @solana/web3.js bs58
```

## Docs

- DFlow order API: https://pond.dflow.net/resources/trading-api/order/order  
- Quickstart: https://pond.dflow.net/spot/recipes/quickstart  
- Auth: `x-api-key` header
