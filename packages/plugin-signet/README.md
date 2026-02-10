# @elizaos/plugin-signet

Onchain advertising plugin for ElizaOS — let your AI agent buy spotlight ads on [Signet](https://signet.sebayaki.com) with USDC via [x402](https://x402.org) payments on Base.

## Overview

Signet is an onchain advertising platform where anyone can pay to place their URL in the spotlight section. This plugin enables ElizaOS agents to estimate costs and purchase spotlight placements programmatically using USDC on Base.

Unlike auction-based advertising (where you bid and wait), Signet uses fixed pricing — agents can post instantly for ~$12 USDC with no bidding or waiting.

## Actions

| Action | Description | Wallet Required |
|--------|-------------|:---:|
| `SIGNET_ESTIMATE` | Check current spotlight pricing and availability | No |
| `SIGNET_POST_SPOTLIGHT` | Pay USDC to place a URL on the spotlight | Yes |

## Providers

| Provider | Description |
|----------|-------------|
| `SIGNET_SPOTLIGHT_STATUS` | Injects current pricing into agent context |

## Configuration

```env
# Required for posting ads — any EVM private key with USDC on Base
SIGNET_PRIVATE_KEY=0x...

# Optional overrides
SIGNET_BASE_URL=https://signet.sebayaki.com   # default
SIGNET_RPC_URL=https://mainnet.base.org        # default
```

Also accepts `BASE_PRIVATE_KEY` or `EVM_PRIVATE_KEY` as fallbacks.

## Usage

Add to your agent character file:

```json
{
  "plugins": ["@elizaos/plugin-signet"]
}
```

Your agent will respond to natural language:

- *"How much does a Signet spotlight ad cost?"* → estimates pricing
- *"Post https://myapp.xyz on Signet spotlight"* → pays USDC and places the ad
- *"Promote https://game.fun on Signet with 6 hour guarantee"* → guaranteed placement

## How It Works

```
Agent → POST /api/x402/spotlight
                ↓
        402 Payment Required (price + payment details)
                ↓
Agent signs EIP-3009 transferWithAuthorization (USDC on Base)
                ↓
Agent → POST /api/x402/spotlight + X-PAYMENT header
                ↓
        Signet settles USDC → executes onchain Zap
                ↓
        ✅ URL appears in spotlight
```

All payments are onchain on Base. No API keys, no accounts — just a wallet with USDC.

## Pricing

| Guarantee | Approximate Cost |
|-----------|-----------------|
| 0h (first-come) | ~$12-13 USDC |
| 1-6h guaranteed | ~$15-50 USDC |
| 12-24h guaranteed | ~$80-200 USDC |

Average spotlight placement receives **400+ clicks**.

## Links

- [Signet](https://signet.sebayaki.com) — the platform
- [x402 Protocol](https://x402.org) — HTTP 402 payment standard
- [Hunt Town](https://hunt.town) — onchain Co-op behind Signet
- [CLI & SDK](https://github.com/h1-hunt/signet-client) — standalone tools

## License

MIT
