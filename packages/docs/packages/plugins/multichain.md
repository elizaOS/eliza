# @elizaos/plugin-multichain

Cross-chain integration plugin for Eliza OS that enables seamless token transfers and swaps across multiple blockchain networks using Chain Signatures and NEAR Intents technologies.

## Overview

This plugin serves as a unified interface for cross-chain interactions, allowing seamless token transfers and swaps across major blockchain networks. It leverages Chain Signatures and NEAR Intents for secure multi-chain transactions and cross-chain token swap.

## Features

- Cross-chain token transfers
- Multi-chain token swaps
- Support for major blockchain networks:
  - Bitcoin
  - Ethereum and EVM chains:
    - Polygon
    - BNB Chain
    - Avalanche
    - Arbitrum
    - Optimism
  - Cosmos ecosystem (coming soon)
- Chain Signatures integration
- NEAR Intents for optimized execution
- Portfolio tracking across chains (coming soon)
- Comprehensive error handling

## Installation

```bash
pnpm install @elizaos/plugin-multichain
```

## Configuration

The plugin requires environment variables for each supported chain:

```env
# NEAR Configuration (for Chain Signatures and Intents)
NEAR_WALLET_SECRET_KEY=your-near-private-key
NEAR_ADDRESS=your-account.near
NEAR_NETWORK=mainnet
NEAR_RPC_URL=https://rpc.mainnet.near.org

# Ethereum Configuration
ETH_RPC_URL=your-eth-rpc-url

# EVM Chain Configurations
POLYGON_RPC_URL=your-polygon-rpc-url
BSC_RPC_URL=your-bsc-rpc-url
AVAX_RPC_URL=your-avax-rpc-url
ARBITRUM_RPC_URL=your-arbitrum-rpc-url
OPTIMISM_RPC_URL=your-optimism-rpc-url

# Global Settings
DEFAULT_SLIPPAGE=0.01  # 1% slippage tolerance
```

## Usage

### Multi-Chain Transfer

```typescript
import { multichainPlugin } from "@elizaos/plugin-multichain";

// Transfer tokens across chains
const result = await eliza.execute({
    action: "MULTI_CHAIN_TRANSFER",
    content: {
        chain: "BTC",
        networkId: "testnet",
        token: null,  // Native BTC
        amount: "0.1",
        recipient: "tb1qmw3xw3y8jtm4054w02kfz58tmf6pcse02twrh8"
    },
});
```

### Cross-Chain Swap

```typescript
const result = await eliza.execute({
    action: "CROSS_CHAIN_SWAP",
    content: {
        sourceChain: "ETH",
        targetChain: "COSMOS",
        inputToken: "ETH",
        outputToken: "ATOM",
        amount: "1.0",
        recipient: "cosmos1..."
    },
});
```

## API Reference

### Actions

#### `MULTI_CHAIN_TRANSFER`

Transfers tokens on multiple chains with a single account

```typescript
{
  action: 'MULTI_CHAIN_TRANSFER',
  content: {
    chain: string,           // The blockchain (e.g., "BTC", "ETH", "COSMOS")
    networkId: string,       // The network of the blockchain (e.g. "mainnet", "testnet")
    token: string,           // Token to transfer
    amount: string,          // Amount to transfer
    recipient: string        // Recipient address on target chain
  }
}
```

#### `CROSS_CHAIN_SWAP`

Executes a token swap across different chains.

```typescript
{
  action: 'CROSS_CHAIN_SWAP',
  content: {
    sourceChain: string,     // Source blockchain
    targetChain: string,     // Target blockchain
    inputToken: string,      // Input token symbol
    outputToken: string,     // Output token symbol
    amount: string,          // Amount to swap
    recipient: string,       // Recipient address
    slippage?: number        // Optional: slippage tolerance
  }
}
```

### Providers

#### MultiChain Provider

Provides cross-chain portfolio tracking and network status.

```typescript
const portfolioInfo = await eliza.getProvider("multichain");
// Returns consolidated portfolio including:
// - Balances across all chains
// - USD values
// - Network status
```

## Troubleshooting

### Common Issues

1. **Cross-Chain Transaction Failures**
    - Verify sufficient gas/fees on source chain
    - Check Bitcoin UTXO availability
    - Confirm bridge/protocol liquidity
    - Monitor transaction status on both chains

2. **Network Issues**
    - Verify RPC endpoints
    - Check network congestion
    - Monitor bridge status
    - Ensure chain signatures are valid

3. **Swap Issues**
    - Verify token pair liquidity
    - Check price impact
    - Monitor slippage
    - Confirm route availability

## Security Best Practices

1. **Key Management**
    - Secure storage of private keys
    - Regular key rotation
    - Multi-signature support
    - Activity monitoring

2. **Transaction Safety**
    - Input validation
    - Amount limits
    - Address verification
    - Transaction simulation

3. **Network Security**
    - Secure RPC endpoints
    - Fallback providers
    - Rate limiting
    - Chain signature verification

## Testing

```bash
pnpm test
```

Development mode:

```bash
pnpm test:watch
```

## Dependencies

- multichain-tools: ^4.0.0
- near-api-js: ^5.0.1
- bignumber.js: ^9.1.2
- node-cache: ^5.1.2

## Contributing

See CONTRIBUTING.md for contribution guidelines.

## Credits

This plugin integrates with multiple blockchain networks and their respective technologies:

- Bitcoin Network
- Ethereum and EVM-compatible chains
- NEAR Protocol (Chain Signatures and NEAR Intents)

Special thanks to:
- The NEAR Protocol team for developing the NEAR blockchain and Chain Signatures
- The Aurora team for developing the NEAR Intents
- The Eliza community for their contributions and feedback.

## License

This plugin is part of the Eliza project. See the main project repository for license information.
