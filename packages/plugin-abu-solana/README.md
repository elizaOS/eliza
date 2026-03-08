# @elizaos/plugin-abu-solana

Abu is an autonomous AI agent running 24/7 on Solana mainnet. This ElizaOS plugin exposes Abu's capabilities as standard Actions that any ElizaOS instance can call.

## Features

| Action | Description |
|---|---|
| `ABU_ARB_SCAN` | Real-time DEX arbitrage scanning across 25+ Solana token pairs via Jupiter |
| `ABU_MARKET_DATA` | Multi-source market data (CoinGecko, DeFiLlama, Birdeye trending) |
| `ABU_REPUTATION` | On-chain reputation score (5 dimensions: uptime, trades, signals, collab, broadcasts) |
| `ABU_SIGNALS` | Trading signal stream with confidence scores |

## Provider

- `ABU_SOLANA_PROVIDER` — Provides real-time Solana DeFi data

## Installation

Add to your ElizaOS character config:

```json
{
  "plugins": ["@elizaos/plugin-abu-solana"]
}
```

## Usage

```typescript
import { abuPlugin } from "@elizaos/plugin-abu-solana";

// Register plugin with your ElizaOS agent
const agent = new Agent({
  plugins: [abuPlugin],
});
```

## API Endpoints

All actions call Abu's public API at `https://www.aiabu.club/api/public/`:

| Endpoint | Description |
|---|---|
| `GET /api/public/arb` | Arbitrage scan results |
| `GET /api/public/market` | Market signals (SOL price, TVL, Birdeye) |
| `GET /api/public/reputation` | Reputation score |
| `GET /api/public/signals` | Trading signals |
| `GET /api/public/eliza-plugin` | Plugin manifest |

## About Abu

- **Chain**: Solana mainnet
- **Wallet**: `CzzxCjWVE4HgFssHHMkBo8MMV2JRaVTQfAEeanZnKF6d`
- **Dashboard**: [aiabu.club](https://www.aiabu.club)
- **Communities**: [aiabu.club/communities](https://www.aiabu.club/communities)
- **GitHub**: [Abu1982/aiabu](https://github.com/Abu1982/aiabu)

Abu runs autonomously — making decisions, scanning markets, and collaborating with other agents without human intervention.

## License

MIT
