# @elizaos/plugin-cronoszkevm

A plugin for interacting with the Cronos zkEVM network within the ElizaOS ecosystem.

## Description

The Cronos zkEVM plugin enables seamless token transfers on the Cronos zkEVM network. It provides functionality for transferring various tokens including ZKCRO, USDC, and ETH using Web3 and zkSync integration.

## Installation

```bash
pnpm install @elizaos/plugin-cronoszkevm
```

## Configuration

The plugin requires the following environment variables to be set:

```typescript
CRONOSZKEVM_ADDRESS=<Your Cronos zkEVM wallet address>
CRONOSZKEVM_PRIVATE_KEY=<Your Cronos zkEVM private key>
```

## Usage

### Basic Integration

```typescript
import { cronosZkEVMPlugin } from "@elizaos/plugin-cronoszkevm";
```

### Example Usage

```typescript
// Send USDC tokens
"Send 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62";

// Send ZKCRO tokens
"Send 100 ZKCRO to 0xbD8679cf79137042214fA4239b02F4022208EE82";

// Send ETH tokens
"Transfer 1 ETH to 0x123...";
```

## API Reference

### Actions

#### SEND_TOKEN

Transfers tokens on the Cronos zkEVM network.

**Aliases:**

- TRANSFER_TOKEN_ON_CRONOSZKEVM
- TRANSFER_TOKENS_ON_CRONOSZK
- SEND_TOKENS_ON_CRONOSZKEVM
- SEND_TOKENS_ON_CRONOSZK
- SEND_ETH_ON_CRONOSZKEVM
- SEND_ETH_ON_CRONOSZK
- PAY_ON_CRONOSZKEVM
- PAY_ON_CRONOSZK

**Input Content:**

```typescript
interface TransferContent {
    tokenAddress: string; // The token contract address
    recipient: string; // The recipient's address
    amount: string | number; // Amount to transfer
}
```

## Common Issues & Troubleshooting

1. **Transaction Failures**

    - Ensure sufficient token balance for transfers
    - Verify correct recipient address format (must start with 0x)
    - Check network connectivity to Cronos zkEVM RPC endpoint

2. **Configuration Issues**
    - Verify CRONOSZKEVM_ADDRESS is properly set
    - Ensure CRONOSZKEVM_PRIVATE_KEY is valid and secure
    - Confirm RPC endpoint is accessible

## Security Best Practices

1. **Private Key Management**

    - Store private keys securely using environment variables
    - Never expose private keys in code or logs
    - Use separate accounts for development and production

2. **Transaction Validation**
    - Always validate addresses before sending transactions
    - Verify token amounts and decimals
    - Implement proper error handling

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

## Common Token Addresses

- ZKCRO/zkCRO: `0x000000000000000000000000000000000000800A`
- USDC/usdc: `0xaa5b845f8c9c047779bedf64829601d8b264076c`
- ETH/eth: `0x898b3560affd6d955b1574d87ee09e46669c60ea`

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Cronos zkEVM](https://cronos.org/zkevm): Layer 2 scaling solution for Cronos
- [Web3.js](https://web3js.org/): Ethereum JavaScript API
- [zkSync](https://zksync.io/): Zero-knowledge rollup technology
- [Ethers.js](https://docs.ethers.org/): Complete Ethereum library
- [Viem](https://viem.sh/): Modern TypeScript Ethereum library

Special thanks to:

- The Cronos team for developing zkEVM
- The Matter Labs team for zkSync technology
- The Web3.js and Ethers.js maintainers
- The Viem development team
- The Eliza community for their contributions and feedback

For more information about Cronos zkEVM capabilities:

- [Cronos zkEVM Documentation](https://docs.cronos.org/zkevm/)
- [zkEVM Bridge](https://zkevm.cronos.org/bridge)
- [Cronos Developer Portal](https://cronos.org/developers)
- [zkSync Integration Guide](https://docs.cronos.org/zkevm/integration)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
