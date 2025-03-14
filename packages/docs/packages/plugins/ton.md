# @elizaos/plugin-ton

A plugin for handling TON (Telegram Open Network) blockchain operations, providing wallet management and transfer capabilities.

## Overview

This plugin provides functionality to:

- Manage TON wallets and key derivation
- Execute secure token transfers
- Query wallet balances and portfolio information
- Format and cache transaction data
- Interface with TON blockchain via RPC endpoints
- Connect TON wallets using TonConnect protocol
- Execute secure token transfers
- Query wallet connection status
- Support multiple wallet applications (like Tonkeeper)
- Support QR Code scanning connection

### Quick Start

```bash
# you should read the debug.sh first!

# if not provide the apikey, the response may very slow
export OPENAI_API_KEY=""

# if not provide the testnet apikey, the transfer action may not stable
# from https://t.me/toncenter to get your testnet apikey
export TON_RPC_API_KEY=""

# nvm use 23 && npm install -g pnpm
bash ./packages/plugin-ton/scripts/debug.sh
```

## Installation

```bash
npm install @elizaos/plugin-ton
```

## Configuration

The plugin requires the following environment variables:

```env
TON_PRIVATE_KEY=your_mnemonic_phrase  # Required - wallet mnemonic words
TON_RPC_URL=your_rpc_endpoint  # Optional - defaults to mainnet RPC
TON_RPC_API_KEY=
TON_MANIFEST_URL=your_manifest_url  # Required - TonConnect manifest URL
TON_BRIDGE_URL=your_bridge_url  # Optional - defaults to https://bridge.tonapi.io/bridge
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { tonPlugin } from "@elizaos/plugin-ton";

export default {
  plugins: [tonPlugin],
  // ... other configuration
};
```

## Features

### WalletProvider

The `WalletProvider` manages wallet operations and portfolio tracking:

```typescript
import { WalletProvider } from "@elizaos/plugin-ton";

// Initialize the provider
const provider = await initWalletProvider(runtime);

// Get wallet balance
const balance = await provider.getWalletBalance();

// Get formatted portfolio
const portfolio = await provider.getFormattedPortfolio(runtime);
```

### TonConnectProvider

The `TonConnectProvider` manages wallet connection operations:

```typescript
import { TonConnectProvider } from "@elizaos/plugin-ton-connect";

// Initialize provider
const provider = await initTonConnectProvider(runtime);

// Connect wallet
const universalLink = await provider.connect();

// Check connection status
const isConnected = provider.isConnected();

// Disconnect
await provider.disconnect();
```

### TransferAction

The `TransferAction` handles token transfers:

```typescript
import { TransferAction } from "@elizaos/plugin-ton";

// Initialize transfer action
const action = new TransferAction(walletProvider);

// Execute transfer
const hash = await action.transfer({
  recipient: "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4",
  amount: "1.5",
});
```

### BatchTransferAction
The `BatchTransferAction` handles transfers of NFTs, Jettons and TON in a single transaction:

```typescript
import { BatchTransferTokens } from "@elizaos/plugin-ton";

// Initialize transfer action
const action = new BatchTransferTokens(walletProvider);
const batchTransfers = {
    transfers: [
        {
            type: "ton",
            recipientAddress: "0QBLy_5Fr6f8NSpMt8SmPGiItnUE0JxgTJZ6m6E8aXoLtJHB",
            amount: "0.1"
        },
        {
            type: "token",
            recipientAddress: "0QBLy_5Fr6f8NSpMt8SmPGiItnUE0JxgTJZ6m6E8aXoLtJHB",
            tokenInd: "0QDIUnzAEsgHLL7YSrvm_u7OYSKw93AQbtdidRdcbm7tQep5",
            amount: "1"
        }
    ]
}
const reports = await batchTransferAction.createBatchTransfer(batchTransfers);
```

### Create Ton Wallet Action

The `CreateTonWallet` action handles on-demand wallet creation with encrypted key storage from user-supplied encryption key:

```typescript
import { CreateTonWallet } from "@elizaos/plugin-ton";

// Initialize transfer action
const action = new CreateTonWallet(runtime);

// Execute transfer
const { walletAddress, mnemonic } = await action.createNewWallet({
    rpcUrl: "https://toncenter.com/api/v2/jsonRPC",
    encryptionPassword: "GAcAWFv6ZXuaJOuSqemxku4",
});
```

### Auction Interaction Action
The `AuctionInteractionTon` action handles Auction interactions

```typescript
import { AuctionInteractionActionTon } from "@elizaos/plugin-ton";

// Initialize transfer action
const action = new AuctionInteractionActionTon(walletProvider);

result = await auctionAction.getAuctionData(auctionAddress);
```
## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

## Dependencies

- `@ton/ton`: Core TON blockchain functionality
- `@ton/crypto`: Cryptographic operations
- `bignumber.js`: Precise number handling
- `node-cache`: Caching functionality
- Other standard dependencies listed in package.json

## API Reference

### Providers

- `walletProvider`: Manages TON wallet operations
- `nativeWalletProvider`: Handles native TON token operations

### Types

```typescript
interface TransferContent {
  recipient: string;
  amount: string | number;
}

interface WalletPortfolio {
  totalUsd: string;
  totalNativeToken: string;
}

interface Prices {
  nativeToken: { usd: string };
}
```

### Configuration Constants

```typescript
const PROVIDER_CONFIG = {
  MAINNET_RPC: "https://toncenter.com/api/v2/jsonRPC",
  STONFI_TON_USD_POOL: "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4",
  CHAIN_NAME_IN_DEXSCREENER: "ton",
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  TON_DECIMAL: BigInt(1000000000),
};
```

## Common Issues/Troubleshooting

### Issue: Balance Fetching Failure

- **Cause**: Incorrect RPC endpoint or network connectivity issues
- **Solution**: Verify `TON_RPC_URL` and network connection

### Issue: Transfer Fails

- **Cause**: Insufficient balance or invalid recipient address
- **Solution**: Ensure sufficient funds and valid recipient address format

## Security Best Practices

- Store private keys securely using environment variables
- Validate all input addresses and amounts
- Use proper error handling for blockchain operations
- Keep dependencies updated for security patches

## Future Enhancements

1. **Wallet Management**

   - Multi-wallet support
   - Hardware wallet integration
   - Advanced key management
   - Batch transaction processing
   - Custom wallet contracts
   - Recovery mechanisms

2. **Smart Contract Integration**

   - Contract deployment tools
   - FunC contract templates
   - Testing framework
   - Upgrade management
   - Gas optimization
   - Security analysis

3. **Token Operations**

   - Jetton creation tools
   - NFT support enhancement
   - Token metadata handling
   - Collection management
   - Batch transfers
   - Token standards

4. **DeFi Features**

   - DEX integration
   - Liquidity management
   - Yield farming tools
   - Price feed integration
   - Swap optimization
   - Portfolio tracking

5. **Developer Tools**

   - Enhanced debugging
   - CLI improvements
   - Documentation generator
   - Integration templates
   - Performance monitoring
   - Testing utilities

6. **Network Features**
   - Workchain support
   - Sharding optimization
   - RPC management
   - Network monitoring
   - Archive node integration
   - Custom endpoints

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [TON Blockchain](https://ton.org/): The Open Network blockchain platform
- [@ton/ton](https://www.npmjs.com/package/@ton/ton): Core TON blockchain functionality
- [@ton/crypto](https://www.npmjs.com/package/@ton/crypto): Cryptographic operations
- [bignumber.js](https://github.com/MikeMcl/bignumber.js/): Precise number handling
- [node-cache](https://github.com/node-cache/node-cache): Caching functionality

Special thanks to:

- The TON Foundation for developing and maintaining the TON blockchain
- The TON Developer community
- The TON SDK maintainers
- The Eliza community for their contributions and feedback

For more information about TON blockchain capabilities:

- [TON Documentation](https://docs.ton.org/)
- [TON Developer Portal](https://ton.org/dev)
- [TON Whitepaper](https://ton.org/whitepaper.pdf)
- [TON API Reference](https://ton.org/docs/#/api)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
