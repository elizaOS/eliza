# @elizaos/plugin-multichain

## Purpose

Cross-chain integration plugin for Eliza OS that enables seamless token transfers and swaps across multiple blockchain networks using Chain Signatures and NEAR Intents technologies.

## Key Features

- Cross-chain token transfers
- Multi-chain token swaps
- Support for major blockchain networks (Bitcoin, Ethereum, EVM chains, Cosmos ecosystem coming soon)
- Chain Signatures integration
- NEAR Intents for optimized execution
- Portfolio tracking across chains (coming soon)
- Comprehensive error handling

## Installation

```bash
bun install @elizaos/plugin-multichain
```

## Configuration

Requires environment variables for each supported chain including NEAR, Ethereum, and various EVM chains, plus global settings like DEFAULT_SLIPPAGE.

## Example Usage

### Multi-Chain Transfer

```typescript
const result = await eliza.execute({
  action: 'MULTI_CHAIN_TRANSFER',
  content: {
    chain: 'BTC',
    networkId: 'testnet',
    token: null, // Native BTC
    amount: '0.1',
    recipient: 'tb1qmw3xw3y8jtm4054w02kfz58tmf6pcse02twrh8',
  },
});
```

### Cross-Chain Swap

```typescript
const result = await eliza.execute({
  action: 'CROSS_CHAIN_SWAP',
  content: {
    sourceChain: 'ETH',
    targetChain: 'COSMOS',
    inputToken: 'ETH',
    outputToken: 'ATOM',
    amount: '1.0',
    recipient: 'cosmos1...',
  },
});
```
