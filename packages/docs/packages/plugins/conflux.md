# @elizaos/plugin-conflux

A plugin for interacting with the Conflux blockchain network within the ElizaOS ecosystem.

## Description

The Conflux plugin enables seamless interaction with both Conflux Core Space and eSpace networks. It provides functionality for token transfers, cross-space bridge operations, and ConfiPump token management (creation, buying, and selling).

## Installation

```bash
pnpm install @elizaos/plugin-conflux
```

## Configuration

The plugin requires the following environment variables to be set:

```typescript
CONFLUX_CORE_PRIVATE_KEY=<Your Conflux Core Space private key>
CONFLUX_CORE_SPACE_RPC_URL=<Conflux Core Space RPC endpoint>
CONFLUX_MEME_CONTRACT_ADDRESS=<ConfiPump contract address>
```

## Usage

### Basic Integration

```typescript
import { confluxPlugin } from "@elizaos/plugin-conflux";
```

### Example Usage

```typescript
// Core Space Transfer
"Send 1 CFX to cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2eaeg85p5";

// Cross-Space Bridge Transfer
"Send 1 CFX to eSpace Address 0x119DA8bbe74B1C5c987D0c64D10eC1dB301d4752";

// ConfiPump Token Creation
"Create a new token called GLITCHIZA with symbol GLITCHIZA and generate a description about it";

// ConfiPump Token Trading
"Buy 0.00069 CFX worth of GLITCHIZA(0x1234567890abcdef)";
"Sell 0.00069 CFX worth of GLITCHIZA(0x1234567890abcdef)";
```

## API Reference

### Actions

#### SEND_CFX

Transfers CFX tokens within Conflux Core Space.

**Aliases:**

- SEND_CONFLUX
- SEND_CFX_CORE_SPACE
- TRANSFER_CFX

**Input Content:**

```typescript
interface TransferContent {
    to: string; // Conflux Core Space address (cfx: prefix)
    amount: string; // Amount of CFX to send
}
```

#### BRIDGE_SEND_CFX

Transfers CFX tokens from Core Space to eSpace.

**Aliases:**

- BRIDGE_SEND_CONFLUX
- CROSS_SPACE_SEND_CFX
- BRIDGE_TRANSFER_CFX
- CROSS_SPACE_TRANSFER_CFX

**Input Content:**

```typescript
interface TransferContent {
    to: string; // Conflux eSpace address (0x prefix)
    amount: string; // Amount of CFX to send
}
```

#### CONFI_PUMP

Manages ConfiPump token operations.

**Aliases:**

- SELL_TOKEN
- BUY_TOKEN
- CREATE_TOKEN

**Input Content:**

```typescript
interface PumpContent {
    action: "CREATE_TOKEN" | "BUY_TOKEN" | "SELL_TOKEN";
    params: {
        name?: string;
        symbol?: string;
        description?: string;
        tokenAddress?: string;
        value?: string;
    };
}
```

## Common Issues & Troubleshooting

1. **Transaction Failures**
    - Ensure sufficient CFX balance for transactions
    - Verify correct address format (cfx: for Core Space, 0x for eSpace)
    - Check RPC endpoint connectivity

## Security Best Practices

1. **Private Key Management**
    - Store private keys securely using environment variables
    - Never expose private keys in code or logs
    - Use separate accounts for development and production

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run the plugin:

```bash
pnpm run dev
```

## Future Enhancements

1. **Advanced Token Management**

    - Batch token transfers
    - Token allowance management
    - Advanced meme token features
    - Token metadata management

2. **Enhanced Bridge Operations**

    - Multi-token bridge support
    - Automated bridge fee optimization
    - Bridge transaction status tracking
    - Cross-space batch operations

3. **Smart Contract Integration**

    - Contract deployment tools
    - Contract interaction templates
    - ABI management system
    - Contract verification tools

4. **Performance Optimizations**

    - Transaction batching
    - Improved caching mechanisms
    - Gas optimization strategies
    - Network request optimization

5. **Developer Tools**

    - CLI tools for common operations
    - Development environment templates
    - Testing utilities
    - Documentation generator

6. **Security Features**

    - Transaction simulation
    - Risk assessment tools
    - Address validation improvements
    - Rate limiting controls

7. **Monitoring and Analytics**
    - Transaction tracking dashboard
    - Performance metrics
    - Error reporting system
    - Usage analytics

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Conflux Network](https://confluxnetwork.org/): Hybrid consensus blockchain
- [js-conflux-sdk](https://www.npmjs.com/package/js-conflux-sdk): Official Conflux JavaScript SDK
- [ConfiPump](https://confipump.io/): Meme token creation platform
- [@conflux-dev/conflux-address-js](https://www.npmjs.com/package/@conflux-dev/conflux-address-js): Address utilities

Special thanks to:

- The Conflux Foundation for developing the network
- The Conflux Developer community
- The ConfiPump team for meme token infrastructure
- The js-conflux-sdk maintainers
- The Eliza community for their contributions and feedback

For more information about Conflux capabilities:

- [Conflux Documentation](https://developer.confluxnetwork.org/)
- [Conflux Portal](https://portal.confluxnetwork.org/)
- [ConfluxScan](https://confluxscan.io/)
- [Cross-Space Bridge](https://bridge.confluxnetwork.org/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
