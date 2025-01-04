# @elizaos/plugin-solana

Core Solana blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Overview

The Solana plugin serves as a foundational component of Eliza OS, bridging Solana blockchain capabilities with the Eliza ecosystem. It provides crucial services for token operations, trading, portfolio management, and DeFi integrations, enabling both automated and user-directed interactions with the Solana blockchain.

## Features

### Token Operations
- **Token Creation**: Deploy new tokens with customizable metadata
- **Token Transfers**: Send and receive tokens securely
- **Balance Management**: Track and manage token balances
- **Portfolio Analytics**: Real-time portfolio valuation and tracking

### Trading Operations
- **Token Swaps**: Execute trades between tokens using Jupiter aggregator
- **Order Management**: Place and track token orders
- **Price Monitoring**: Real-time price feeds and historical data
- **Automated Trading**: Configurable trading strategies and automation

### DeFi Integration
- **Liquidity Analysis**: Monitor and analyze pool liquidity
- **Market Making**: Automated market making capabilities
- **Yield Optimization**: Smart routing for optimal yields
- **Risk Management**: Advanced risk scoring and monitoring

### Trust & Security
- **Trust Scoring**: Dynamic trust score calculation for tokens
- **Risk Assessment**: Real-time risk evaluation for trades
- **Performance Tracking**: Historical performance monitoring
- **Simulation Mode**: Test strategies without real transactions

## Security Features

### Access Control
- **Wallet Management**: Secure wallet key derivation and storage
- **Permission Scoping**: Granular control over trading permissions
- **TEE Integration**: Trusted Execution Environment support
- **Key Protection**: Secure private key handling

### Risk Management
- **Trade Limits**: Configurable transaction limits
- **Slippage Protection**: Automatic slippage controls
- **Validation Checks**: Multi-level transaction validation
- **Simulation Support**: Pre-execution transaction simulation
## Installation

```bash
npm install @elizaos/plugin-solana
```

## Configuration

Configure the plugin by setting the following environment variables:

```typescript
const solanaEnvSchema = {
    WALLET_SECRET_SALT: string (optional),
    WALLET_SECRET_KEY: string,
    WALLET_PUBLIC_KEY: string,
    SOL_ADDRESS: string,
    SLIPPAGE: string,
    RPC_URL: string,
    HELIUS_API_KEY: string,
    BIRDEYE_API_KEY: string
}
```

## Usage

### Basic Setup
```typescript
import { solanaPlugin } from "@elizaos/plugin-solana";

// Initialize the plugin
const runtime = await initializeRuntime({
    plugins: [solanaPlugin]
});
```

### Services

#### TokenProvider
Manages token operations and information retrieval.
```typescript
const tokenProvider = new TokenProvider(tokenAddress, walletProvider, cacheManager);
await tokenProvider.getTokensInWallet(runtime);
```

#### WalletProvider
Handles wallet operations and portfolio management.
```typescript
const walletProvider = new WalletProvider(connection, publicKey);
await walletProvider.getFormattedPortfolio(runtime);
```

#### TrustScoreProvider
Evaluates and manages trust scores for tokens and trading activities.
```typescript
const trustScore = await runtime.getProvider("trustScore");
```
## Actions

### executeSwap
Executes a token swap using Jupiter aggregator.

```typescript
// Example usage
const result = await runtime.executeAction("EXECUTE_SWAP", {
    inputTokenSymbol: "SOL",
    outputTokenSymbol: "USDC",
    amount: 0.1
});
```

### transferToken
Transfers tokens between wallets.

```typescript
// Example usage
const result = await runtime.executeAction("TRANSFER_TOKEN", {
    tokenAddress: "TokenAddressHere",
    recipient: "RecipientAddressHere",
    amount: "1000"
});
```

### takeOrder
Places a buy order based on conviction level.

```typescript
// Example usage
const result = await runtime.executeAction("TAKE_ORDER", {
    ticker: "SOL",
    contractAddress: "ContractAddressHere"
});
```

### pumpfun
Creates and buys tokens on pump.fun.

```typescript
// Example usage
const result = await runtime.executeAction("CREATE_AND_BUY_TOKEN", {
    tokenMetadata: {
        name: "TokenName",
        symbol: "SYMBOL",
        description: "Token description",
        image_description: "Image description"
    },
    buyAmountSol: 0.1
});
```

### fomo
Creates and buys tokens on fomo.fund.

```typescript
// Example usage
const result = await runtime.executeAction("CREATE_AND_BUY_TOKEN", {
    tokenMetadata: {
        name: "TokenName",
        symbol: "SYMBOL",
        description: "Token description",
        image_description: "Image description"
    },
    buyAmountSol: 0.1,
    requiredLiquidity: 1000
});
```
### executeSwapForDAO
Executes token swaps for DAO operations.

```typescript
// Example usage
const result = await runtime.executeAction("EXECUTE_SWAP_DAO", {
    inputTokenSymbol: "SOL",
    outputTokenSymbol: "USDC",
    amount: 0.1
});
```

## Performance Optimization

1. **Cache Management**
   - Implement token data caching
   - Configure cache TTL settings
   - Monitor cache hit rates

2. **RPC Optimization**
   - Use connection pooling
   - Implement request batching
   - Monitor RPC usage

3. **Transaction Management**
   - Optimize transaction bundling
   - Implement retry strategies
   - Monitor transaction success rates


## System Requirements

- Node.js 16.x or higher
- Solana CLI tools (optional)
- Minimum 4GB RAM recommended
- Stable internet connection
- Access to Solana RPC endpoint

## Troubleshooting

### Common Issues

1. **Wallet Connection Failures**
```bash
Error: Failed to connect to wallet
```
- Verify RPC endpoint is accessible
- Check wallet configuration settings
- Ensure proper network selection

2. **Transaction Errors**
```bash
Error: Transaction simulation failed
```
- Check account balances
- Verify transaction parameters
- Ensure proper fee configuration

3. **Price Feed Issues**
```bash
Error: Unable to fetch price data
```
- Verify API key configuration
- Check network connectivity
- Ensure price feed service status

## Safety & Security
### Best Practices
1. **Environment Variables**
   - Store sensitive keys in environment variables
   - Use .env.example for non-sensitive defaults
   - Never commit real credentials to version control

2. **Transaction Limits**
   - Set maximum transaction amounts
   - Implement daily trading limits
   - Configure per-token restrictions

3. **Monitoring**
   - Track failed transaction attempts
   - Monitor unusual trading patterns
   - Log security-relevant events

4. **Recovery**
   - Implement transaction rollback mechanisms
   - Maintain backup RPC endpoints
   - Document recovery procedures


## Performance Optimization

1. **Cache Management**
   - Implement token data caching
   - Configure cache TTL settings
   - Monitor cache hit rates

2. **RPC Optimization**
   - Use connection pooling
   - Implement request batching
   - Monitor RPC usage

3. **Transaction Management**
   - Optimize transaction bundling
   - Implement retry strategies
   - Monitor transaction success rates

## Support

For issues and feature requests, please:
1. Check the troubleshooting guide above
2. Review existing GitHub issues
3. Submit a new issue with:
   - System information
   - Error logs
   - Steps to reproduce
   - Transaction IDs (if applicable)

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Solana](https://solana.com/) - The core blockchain platform
- [Solana Web3.js](https://github.com/solana-labs/solana-web3.js) - Core Solana interactions
- [SPL Token](https://spl.solana.com/) - Token program interactions
- [Jupiter](https://jup.ag/) - Token swap aggregation
- [Birdeye](https://birdeye.so/) - Price feeds and analytics
- [Helius](https://helius.xyz/) - Enhanced RPC services
- [Anchor](https://project-serum.github.io/anchor/) - Smart contract framework
- [FOMO](https://fomo.fund/) - Token creation and trading
- [Pump.fun](https://pump.fun/) - Token creation and trading

Special thanks to:
- The Solana ecosystem and all the open-source contributors who make these integrations possible.
- The Eliza community for their contributions and feedback.

For more information about Solana blockchain capabilities:
- [Solana Documentation](https://docs.solana.com/)
- [Solana Developer Portal](https://solana.com/developers)
- [Solana Network Dashboard](https://solscan.io/)
- [Solana GitHub Repository](https://github.com/solana-labs/solana)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
