# @elizaos/plugin-aptos

A plugin for interacting with the Aptos blockchain network within the ElizaOS ecosystem.

## Description

The Aptos plugin enables seamless token transfers and wallet management on the Aptos blockchain. It provides functionality to transfer APT tokens and monitor wallet balances with real-time price tracking.

## Installation

```bash
pnpm install @elizaos/plugin-aptos
```

## Configuration

The plugin requires the following environment variables to be set:

```typescript
APTOS_PRIVATE_KEY=<Your Aptos private key>
APTOS_NETWORK=<"mainnet" | "testnet">
```

## Usage

### Basic Integration

```typescript
import {
    aptosPlugin,
    WalletProvider,
    TransferAptosToken,
} from "@elizaos/plugin-aptos";
```

### Transfer Examples

```typescript
// The plugin responds to natural language commands like:

"Send 69 APT tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0";
"Transfer APT to [address]";
"Pay [amount] APT to [recipient]";
```

## API Reference

### Actions

#### SEND_TOKEN

Transfers APT tokens from the agent's wallet to another address.

**Aliases:**

- TRANSFER_TOKEN
- TRANSFER_TOKENS
- SEND_TOKENS
- SEND_APT
- PAY

**Configuration:**

```typescript
{
    APT_DECIMALS: 8; // Decimal places for APT token
}
```

### Providers

#### WalletProvider

Provides wallet information and portfolio tracking.

**Features:**

- Real-time APT price tracking
- Portfolio value calculation
- Cached wallet information (5-minute TTL)
- Formatted portfolio reports

## Common Issues & Troubleshooting

1. **Transaction Failures**

    - Verify wallet has sufficient APT balance
    - Check recipient address format
    - Ensure private key is correctly set
    - Verify network connectivity

2. **Price Fetching Issues**
    - Check connection to DexScreener API
    - Verify cache functionality
    - Monitor retry mechanism (3 attempts with exponential backoff)

## Security Best Practices

1. **Private Key Management**
    - Store private key securely using environment variables
    - Never commit private keys to version control
    - Use separate wallets for development and production
    - Monitor wallet activity regularly

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

4. Run tests:

```bash
pnpm run test
```

5. Development mode:

```bash
pnpm run dev
```

## Dependencies

- @aptos-labs/ts-sdk: ^1.26.0
- bignumber.js: 9.1.2
- node-cache: 5.1.2

## Future Enhancements

The following features and improvements are planned for future releases:

1. **Advanced Token Operations**

    - Batch token transfers
    - Token creation templates
    - NFT minting and management
    - Token metadata management
    - Custom tokenomics implementation
    - Token upgrade mechanisms

2. **DeFi Integration**

    - Liquidity pool management
    - Yield farming automation
    - Staking optimization
    - AMM integration
    - Cross-chain bridges
    - Price impact analysis

3. **Move Contract Management**

    - Contract deployment tools
    - Contract verification
    - Contract upgrade system
    - Testing framework
    - Gas optimization tools
    - Security audit integration

4. **Wallet Enhancements**

    - Multi-wallet support
    - Hardware wallet integration
    - Transaction batching
    - Address book management
    - Custom signature schemes
    - Account abstraction

5. **Price Feed Improvements**

    - Additional data sources
    - Real-time price alerts
    - Historical data analysis
    - Custom price aggregation
    - Price prediction tools
    - Market sentiment analysis

6. **Developer Tools**

    - Enhanced debugging capabilities
    - Move language IDE integration
    - Documentation generator
    - Performance profiling
    - Testing utilities
    - Deployment automation

7. **Security Features**

    - Transaction simulation
    - Risk assessment tools
    - Rate limiting controls
    - Fraud detection
    - Emergency shutdown
    - Multi-signature support

8. **Analytics and Monitoring**
    - Transaction tracking
    - Portfolio analytics
    - Network statistics
    - Gas usage optimization
    - Performance metrics
    - Custom reporting tools

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Aptos](https://aptoslabs.com/): Layer 1 blockchain platform
- [@aptos-labs/ts-sdk](https://github.com/aptos-labs/aptos-core/tree/main/ecosystem/typescript/sdk): Official TypeScript SDK
- [Petra Wallet](https://petra.app/): Aptos wallet integration
- [DexScreener](https://dexscreener.com/): Price feed integration
- [Move Language](https://github.com/move-language/move): Smart contract language

Special thanks to:

- The Aptos Labs team for developing the blockchain
- The Petra Wallet development team
- The DexScreener team for price data
- The Move language developers
- The Aptos Developer community
- The Eliza community for their contributions and feedback

For more information about Aptos capabilities:

- [Aptos Documentation](https://aptos.dev/)
- [Move Language Guide](https://move-language.github.io/move/)
- [Petra Wallet Docs](https://petra.app/docs)
- [DexScreener API](https://docs.dexscreener.com/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
