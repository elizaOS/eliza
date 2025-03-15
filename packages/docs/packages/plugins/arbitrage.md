# ElizaOS Arbitrage Plugin

A powerful DEX arbitrage trading plugin for ElizaOS, designed to identify and automatically execute profitable cross-market trading opportunities on Ethereum-based decentralized exchanges.

## Overview

The ElizaOS Arbitrage Plugin monitors multiple decentralized exchanges (DEXs) like Uniswap and Sushiswap for price discrepancies in token pairs. When it identifies a profitable arbitrage opportunity that exceeds the configured threshold, it automatically executes the trade using Flashbots bundles to maximize profits and minimize risk.

## Features

- **Real-time Market Monitoring**: Continuously watches market conditions across multiple DEXs via WebSocket connections
- **Automated Opportunity Detection**: Analyzes price differences to identify profitable arbitrage paths
- **Smart Trade Execution**: Uses Flashbots to execute trades privately and avoid front-running
- **Configurable Trading Parameters**: Customizable profit thresholds, gas limits, and other trading parameters
- **Risk Management**: Advanced volume optimization to minimize price impact and maximize profits
- **Performance Optimization**: Efficient batch processing and concurrent operations for minimal latency

## Prerequisites

- Node.js 18 or higher
- An Ethereum wallet with private key
- Access to an Ethereum WSS endpoint
- Flashbots relay signing key
- Bundle executor smart contract deployment

## Installation

```bash
npm install @elizaos-plugins/plugin-arbitrage
```

## Configuration

To use the plugin, you need to configure your ElizaOS character with the necessary settings:

```json
{
    "name": "Trader",
    "settings": {
        "secrets": {
            "EVM_PRIVATE_KEY": "YOUR_PRIVATE_KEY_HERE",
            "FLASHBOTS_RELAY_SIGNING_KEY": "YOUR_FLASHBOTS_KEY_HERE",
            "BUNDLE_EXECUTOR_ADDRESS": "YOUR_EXECUTOR_ADDRESS_HERE"
        },
        "arbitrage": {
            "ethereumWsUrl": "YOUR_ETH_WSS_URL",
            "rpcUrl": "YOUR_ETH_RPC_URL"
        }
    },
    "plugins": [
        "@elizaos/plugin-arbitrage",
        "@elizaos/plugin-evm"
    ]
}
```

### Required Settings

| Setting | Description |
|---------|-------------|
| `EVM_PRIVATE_KEY` | Private key for your Ethereum wallet (keep this secure!) |
| `FLASHBOTS_RELAY_SIGNING_KEY` | Signing key for Flashbots bundles |
| `BUNDLE_EXECUTOR_ADDRESS` | Address of your bundle executor contract |
| `ethereumWsUrl` | WebSocket URL for your Ethereum node |
| `rpcUrl` | RPC URL for your Ethereum node |

## Usage

The plugin integrates with ElizaOS and provides the following capabilities:

### Actions

- `EXECUTE_ARBITRAGE`: Scans for and executes profitable arbitrage opportunities

### Providers

- `marketProvider`: Provides real-time market data and arbitrage opportunities

### Example Interactions

```
User: "Find arbitrage opportunities"
Trader: "Scanning for arbitrage trades..."
```

## Advanced Configuration

You can customize trading parameters by modifying the thresholds in `src/config/thresholds.ts`:

```typescript
export const DEFAULT_THRESHOLDS: MarketThresholds = {
    minProfitThreshold: BigNumber.from("100000000000000"), // 0.0001 ETH
    maxTradeSize: BigNumber.from("1000000000000000000"), // 1 ETH
    gasLimit: 500000,
    minerRewardPercentage: 90
};
```

## Architecture

The plugin consists of several key components:

- **Core Engine**: Implements the arbitrage detection and execution logic
- **Market Adapters**: Interfaces with various DEXs like Uniswap and Sushiswap
- **WebSocket Manager**: Handles real-time market data updates
- **Service Layer**: Integrates with ElizaOS to provide plugin functionality

## Security Considerations

- Ensure your private keys are stored securely
- Test with small amounts before deploying with significant capital
- Monitor gas costs to ensure profitability
- Implement circuit breakers for market volatility
