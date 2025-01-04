# @elizaos/plugin-fuel

A plugin for interacting with the Fuel blockchain within the ElizaOS ecosystem.

## Description

This plugin provides essential functionality for interacting with the Fuel blockchain, focusing on ETH transfers on the Fuel Ignition network. It offers a streamlined way to manage Fuel blockchain transactions through natural language commands.

## Installation

```bash
pnpm install @elizaos/plugin-fuel
```

## Configuration

The plugin requires the following environment variables to be set:
```typescript
FUEL_PRIVATE_KEY=<Private key for the Fuel wallet starting with 0x>
FUEL_PROVIDER_URL=<Custom RPC endpoint URL (optional, defaults to "https://mainnet.fuel.network/v1/graphql")>
```

## Usage

### Basic Integration

```typescript
import { fuelPlugin } from '@elizaos/plugin-fuel';
```

### Example Usage

The plugin supports natural language commands for ETH transfers:

```typescript
"Transfer 1 ETH to 0x8F8afB12402C9a4bD9678Bec363E51360142f8443FB171655eEd55dB298828D1"
```

## API Reference

### Actions

#### TRANSFER

Transfers ETH between addresses on the Fuel Ignition network.

**Aliases:**
- TRANSFER_FUEL_ETH
- SEND_TOKENS

**Input Content:**
```typescript
interface TransferParams {
    toAddress: string;    // Recipient's Fuel address
    amount: string;       // Amount of ETH to transfer
}
```

## Common Issues & Troubleshooting

1. **Connection Issues**
   - Verify provider URL is accessible
   - Check network connectivity
   - Ensure proper network configuration

2. **Transaction Failures**
   - Verify sufficient balance for transfers
   - Check correct address format
   - Ensure gas fees can be covered

3. **Authentication Issues**
   - Validate private key format
   - Verify wallet configuration
   - Check network permissions

## Security Best Practices

1. **Key Management**
   - Store private keys securely
   - Use environment variables for sensitive data
   - Never expose private keys in code or logs

2. **Transaction Safety**
   - Validate recipient addresses
   - Implement proper error handling
   - Double-check transaction amounts

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
pnpm test
```

## Future Enhancements

- Support for token transfers
- Enhanced error handling and recovery
- Additional Fuel blockchain interactions
- Transaction status monitoring
- Balance tracking improvements

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Fuel Network](https://fuel.network/): High-performance modular execution layer
- [fuels-ts](https://github.com/FuelLabs/fuels-ts): TypeScript SDK for Fuel
- [Fuel Wallet](https://wallet.fuel.network/): Official Fuel wallet
- [Fuel GraphQL API](https://docs.fuel.network/docs/graphql/): Network interaction

Special thanks to:
- The Fuel Labs team for developing the Fuel Network
- The Fuel Developer community
- The fuels-ts SDK maintainers
- The Eliza community for their contributions and feedback

For more information about Fuel capabilities:
- [Fuel Documentation](https://docs.fuel.network/)
- [Fuel Developer Portal](https://developers.fuel.network/)
- [Fuel Network Dashboard](https://app.fuel.network/)
- [Fuel GitHub Repository](https://github.com/FuelLabs)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

