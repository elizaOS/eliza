# @elizaos/plugin-monad

Monad blockchain integration plugin for ElizaOS. Provides on-chain data queries for the Monad network.

## Features

### Actions

| Action | Description | Triggers |
|--------|-------------|----------|
| `MONAD_QUERY_BALANCE` | Query MON balance | "balance", "余额" |
| `MONAD_QUERY_TX` | Query transaction details | "transaction", "交易" |
| `MONAD_QUERY_BLOCK` | Query block information | "block", "区块" |
| `MONAD_QUERY_NONCE` | Query transaction count | "nonce", "交易数" |
| `MONAD_QUERY_GAS` | Query gas price | "gas", "手续费" |

### Providers

| Provider | Description |
|----------|-------------|
| `MONAD_CHAIN` | Provides Monad chain status context |

## Installation

```bash
npm install @elizaos/plugin-monad
```

## Usage

```typescript
import monadPlugin from "@elizaos/plugin-monad";

// Add to your agent's plugins
const agent = {
  plugins: [monadPlugin],
  // ... other config
};
```

## Examples

### Query Balance

```
User: What's the MON balance of 0x3194d81BB0758f3D2D66936E7740670f376dFDBb?
Agent: [MONAD_QUERY_BALANCE]
       Monad testnet wallet balance:
       Address: 0x3194d81BB0758f3D2D66936E7740670f376dFDBb
       Balance: 4.970012 MON
```

### Query Transaction

```
User: Look up this Monad transaction: 0x1234...
Agent: [MONAD_QUERY_TX]
       Transaction hash: 0x1234...
       Block: 35474300
       From: 0x...
       To: 0x...
       Value: 0.01 MON
       Status: ✅ Success
```

### Query Block

```
User: What's the latest block on Monad?
Agent: [MONAD_QUERY_BLOCK]
       Block height: 35474300
       Transactions: 156
       Gas used: 12,345,678
```

### Query Gas

```
User: Monad gas fee?
Agent: [MONAD_QUERY_GAS]
       Gas price: 0.001 Gwei
       Monad is known for high throughput and low gas fees.
```

## Configuration

The plugin uses the following default configuration:

```typescript
const MONAD_CONFIG = {
  testnet: {
    rpc: "https://testnet-rpc.monad.xyz",
    chainId: 10143,
    explorer: "https://testnet.monadexplorer.com",
    currency: "MON",
  },
  mainnet: {
    rpc: "https://rpc.monad.xyz", // Update when mainnet launches
    chainId: 10143, // Update when mainnet launches
    explorer: "https://monadexplorer.com",
    currency: "MON",
  },
};
```

## Network Support

- **Testnet**: Fully supported (Chain ID: 10143)
- **Mainnet**: Placeholder configuration (update RPC when mainnet launches)

## Language Support

The plugin supports both English and Chinese triggers:

- English: "balance", "transaction", "block", "gas", "nonce"
- Chinese: "余额", "交易", "区块", "手续费", "交易数"

## Development

```bash
# Build
npm run build

# Test
npm test

# Development mode
npm run dev
```

## About Monad

Monad is a high-performance EVM-compatible Layer 1 blockchain:

- **TPS**: 10,000+ transactions per second
- **Block Time**: 1 second
- **EVM Compatible**: Full Ethereum compatibility
- **Consensus**: MonadBFT

## License

MIT
