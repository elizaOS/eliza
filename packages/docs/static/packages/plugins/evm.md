# @elizaos/plugin-evm

## Purpose

Provides actions and providers for interacting with EVM-compatible chains, including token transfers, cross-chain bridging, and token swaps using LiFi integration.

## Key Features

- Multi-chain support with dynamic chain configuration
- Native token transfers
- Cross-chain token bridging via LiFi
- Token swapping on supported DEXs
- Wallet balance tracking
- Custom RPC endpoint configuration
- Automatic retry mechanisms
- Comprehensive transaction management

## Installation

```bash
bun install @elizaos/plugin-evm
```

## Configuration

### Required Environment Variables:

```env
# Required
EVM_PRIVATE_KEY=your-private-key-here

# Optional - Custom RPC URLs
EVM_PROVIDER_URL=https://your-custom-mainnet-rpc-url
ETHEREUM_PROVIDER_<CHAIN_NAME>=https://your-custom-rpc-url
```

Chain Configuration in character config:

```json
"settings": {
    "chains": {
        "evm": [
            "base", "arbitrum", "iotex"
        ]
    }
}
```

## Integration

The Wallet Provider initializes with the first chain in the list as default (or Ethereum mainnet if none added). It provides context of the currently connected address and balance, creates Public and Wallet clients, and allows adding chains dynamically.

## Example Usage

```typescript
// Transfer native tokens
Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e

// Bridge tokens between chains
Bridge 1 ETH from Ethereum to Base

// Swap tokens on same chain
Swap 1 ETH for USDC on Base

// Governance actions
Propose a proposal to the 0xdeadbeef00000000000000000000000000000000 governor on Ethereum to transfer 1 ETH to 0xRecipient.
```
