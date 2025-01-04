# @elizaos/plugin-evm

This plugin provides actions and providers for interacting with EVM-compatible chains.

## Description

The EVM plugin provides comprehensive functionality for interacting with EVM-compatible chains, including token transfers, cross-chain bridging, and token swaps using LiFi integration.

## Features

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
pnpm install @elizaos/plugin-evm
```

## Configuration

### Required Environment Variables

```env
# Required
EVM_PRIVATE_KEY=your-private-key-here

# Optional - Custom RPC URLs
EVM_PROVIDER_URL=https://your-custom-mainnet-rpc-url
ETHEREUM_PROVIDER_<CHAIN_NAME>=https://your-custom-rpc-url
```

### Chain Configuration

By default, **Ethereum mainnet** is enabled. To enable additional chains, add them to your character config:

```json
"settings": {
    "chains": {
        "evm": [
            "base", "arbitrum", "iotex"
        ]
    }
}
```

Note: The chain names must match those in the viem/chains.

### Custom RPC URLs

By default, the RPC URL is inferred from the `viem/chains` config. To use a custom RPC URL for a specific chain, add the following to your `.env` file:

```env
ETHEREUM_PROVIDER_<CHAIN_NAME>=https://your-custom-rpc-url
```

**Example usage:**

```env
ETHEREUM_PROVIDER_IOTEX=https://iotex-network.rpc.thirdweb.com
```

#### Custom RPC for Ethereum Mainnet

To set a custom RPC URL for Ethereum mainnet, use:

```env
EVM_PROVIDER_URL=https://your-custom-mainnet-rpc-url
```

## Provider

The **Wallet Provider** initializes with the **first chain in the list** as the default (or Ethereum mainnet if none are added). It:

- Provides the **context** of the currently connected address and its balance.
- Creates **Public** and **Wallet clients** to interact with the supported chains.
- Allows adding chains dynamically at runtime.

## Actions

### 1. Transfer

Transfer native tokens on the same chain:

```typescript
// Example: Transfer 1 ETH
Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e
```

### 2. Bridge

Bridge tokens between different chains using LiFi:

```typescript
// Example: Bridge ETH from Ethereum to Base
Bridge 1 ETH from Ethereum to Base
```

### 3. Swap

Swap tokens on the same chain using LiFi:

```typescript
// Example: Swap ETH for USDC
Swap 1 ETH for USDC on Base
```

## Development

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run tests:

```bash
pnpm test
```

## API Reference

### Core Components

1. **WalletProvider**
   - Manages wallet connections
   - Handles chain switching
   - Manages RPC endpoints
   - Tracks balances

2. **Actions**
   - TransferAction: Native token transfers
   - BridgeAction: Cross-chain transfers
   - SwapAction: Same-chain token swaps

## Future Enhancements

1. **Cross-Chain Operations**
   - Enhanced bridge aggregation
   - Multi-chain transaction batching
   - Cross-chain liquidity management
   - Bridge fee optimization
   - Chain-specific gas strategies
   - Cross-chain messaging

2. **DeFi Integration**
   - Advanced swap routing
   - Yield farming automation
   - Liquidity pool management
   - Position management tools
   - MEV protection features
   - Flash loan integration

3. **Smart Contract Management**
   - Contract deployment templates
   - Verification automation
   - Upgrade management
   - Security analysis tools
   - Gas optimization
   - ABI management system

4. **Token Operations**
   - Batch transfer tools
   - Token approval management
   - Token metadata handling
   - Custom token standards
   - Token bridging optimization
   - NFT support enhancement

5. **Wallet Features**
   - Multi-signature support
   - Account abstraction
   - Hardware wallet integration
   - Social recovery options
   - Transaction simulation
   - Batch transaction processing

6. **Network Management**
   - Dynamic RPC management
   - Network health monitoring
   - Fallback provider system
   - Custom network addition
   - Gas price optimization
   - Network analytics

7. **Security Enhancements**
   - Transaction validation
   - Risk assessment tools
   - Fraud detection
   - Rate limiting
   - Emergency shutdown
   - Audit integration

8. **Developer Tools**
   - Enhanced debugging
   - Testing framework
   - Documentation generator
   - CLI improvements
   - Performance profiling
   - Integration templates

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

The plugin contains tests. Whether you're using **TDD** or not, please make sure to run the tests before submitting a PR:

```bash
pnpm test
```

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Ethereum](https://ethereum.org/): Decentralized blockchain
- [LiFi](https://lifi.io/): Cross-chain bridge and swap service
- [viem](https://viem.sh/): Ethereum client library
- [wagmi](https://wagmi.sh/): Ethereum client library

Special thanks to:
- [Ethereum Developer community](https://ethereum.org/developers/)
- The Eliza community for their contributions and feedback

For more information about EVM capabilities:
- [Ethereum Documentation](https://ethereum.org/developers/)
- [LiFi Documentation](https://lifi.io)
- [viem Documentation](https://viem.sh)
- [wagmi Documentation](https://wagmi.sh)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
