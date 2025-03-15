# @elizaos/plugin-starknet

Core Starknet blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Overview

The Starknet plugin serves as a foundational component of Eliza OS, bridging Starknet blockchain capabilities with the Eliza ecosystem. It provides crucial services for token operations, trading, portfolio management, and DeFi integrations, enabling both automated and user-directed interactions with the Starknet blockchain.

## Features

### Token Operations

- **Token Creation**: Deploy new unruggable tokens with customizable metadata
- **Token Transfers**: Send and receive tokens securely
- **Balance Management**: Track and manage token balances
- **Portfolio Analytics**: Real-time portfolio valuation and tracking

### Trading Operations

- **Token Swaps**: Execute token swaps through aggregated DEX liquidity
- **Order Management**: Place and manage trading orders
- **Price Monitoring**: Track token prices and market movements
- **Trust Score Analysis**: Evaluate token and trader reliability

### DeFi Integration

- **Liquidity Management**: Monitor and manage liquidity positions
- **Yield Optimization**: Track and optimize yield farming opportunities
- **Risk Assessment**: Analyze and monitor DeFi protocol risks
- **Performance Tracking**: Monitor investment performance metrics

## Configuration

The plugin requires the following environment variables:

```typescript
STARKNET_ADDRESS = your_starknet_address;
STARKNET_PRIVATE_KEY = your_private_key;
STARKNET_RPC_URL = your_rpc_url;  // e.g. https://rpc.starknet.lava.build
```

## Actions

### deployToken

Deploys a new unruggable token on Starknet.

```typescript
// Example usage
const result = await runtime.executeAction(
    "DEPLOY_STARKNET_UNRUGGABLE_MEME_TOKEN",
    {
        name: "TokenName",
        symbol: "TKN",
        owner: "OwnerAddressHere",
        initialSupply: "1000000000000000000",
    }
);
```

### transferToken

Transfers tokens between wallets.

```typescript
// Example usage
const result = await runtime.executeAction("TRANSFER_TOKEN", {
    tokenAddress: "TokenAddressHere",
    recipient: "RecipientAddressHere",
    amount: "1000",
});
```

### executeSwap

Executes a token swap on Starknet.

```typescript
// Example usage
const result = await runtime.executeAction("EXECUTE_STARKNET_SWAP", {
    sellTokenAddress: "SellTokenAddressHere",
    buyTokenAddress: "BuyTokenAddressHere",
    sellAmount: "1000000000000000000",
});
```

### transferSubdomain

Creates and transfers a subdomain.

```typescript
// Example usage
const result = await runtime.executeAction("CREATE_SUBDOMAIN", {
    subdomain: "subdomain.domain.stark",
    recipient: "RecipientAddressHere",
});
```

## Security Considerations

1. **Access Control**

    - Validate transaction signers
    - Implement role-based permissions
    - Secure private key storage

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
    - Batch similar transactions
    - Optimize gas usage
    - Handle transaction retries

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Starknet](https://starknet.io/) - The core blockchain platform
- [Starknet.js](https://github.com/starknet-io/starknet.js) - Core Starknet interactions
- [Unruggable](https://unruggable.meme/) - Token creation and security
- [Ekubo](https://www.ekubo.org/) - DEX integrations
- [Avnu](https://avnu.fi/) - Token swap aggregation
- [Birdeye](https://birdeye.so/) - Price feeds and analytics
- [Helius](https://helius.xyz/) - Enhanced RPC services

Special thanks to:

- The Starknet ecosystem and all the open-source contributors who make these integrations possible.
- The Eliza community for their contributions and feedback.

For more information about Starknet blockchain capabilities:

- [Starknet Documentation](https://docs.starknet.io/)
- [Starknet Developer Portal](https://starknet.io/developers)
- [Starknet Network Dashboard](https://starknet.io/dashboard)
- [Starknet GitHub Repository](https://github.com/starkware-libs/starknet)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
