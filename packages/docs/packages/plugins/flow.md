# @elizaos/plugin-flow

A plugin for interacting with the Flow blockchain within the ElizaOS ecosystem.

## Description

This plugin provides essential functionality for interacting with the Flow blockchain, including native FLOW token transfers, fungible token transfers, and EVM token interactions. It offers a seamless way to manage Flow blockchain transactions through natural language commands.

## Installation

```bash
pnpm install @elizaos/plugin-flow
```

## Configuration

The plugin requires the following environment variables to be set:

```typescript
FLOW_ADDRESS=<Flow wallet address starting with 0x>
FLOW_PRIVATE_KEY=<Private key for the Flow wallet starting with 0x>
FLOW_NETWORK=<Network to connect to: "mainnet", "testnet", or "emulator" (optional, defaults to "mainnet")>
FLOW_ENDPOINT_URL=<Custom RPC endpoint URL (optional)>
```

## Usage

### Basic Integration

```typescript
import { flowPlugin } from "@elizaos/plugin-flow";
```

### Example Usage

The plugin supports natural language commands for token transfers:

```typescript
"Send 5 FLOW to 0xa51d7fe9e0080662";
"Send 1 FLOW - A.1654653399040a61.FlowToken to 0xa2de93114bae3e73";
"Send 1000 FROTH - 0xb73bf8e6a4477a952e0338e6cc00cc0ce5ad04ba to 0x000000000000000000000002e44fbfbd00395de5";
```

## API Reference

### Actions

#### SEND_COIN

Transfers native FLOW tokens, Cadence fungible tokens, or EVM tokens to specified addresses.

**Aliases:**

- SEND_TOKEN
- SEND_TOKEN_ON_FLOW
- TRANSFER_TOKEN_ON_FLOW
- TRANSFER_TOKENS_ON_FLOW
- TRANSFER_FLOW
- SEND_FLOW
- PAY_BY_FLOW

**Input Content:**

```typescript
interface TransferContent {
    token: string | null; // null for native FLOW, Cadence identifier, or EVM address
    amount: string; // Amount to transfer
    to: string; // Recipient address (Flow or EVM)
    matched: boolean; // Indicates if token and address types match
}
```

## Common Issues & Troubleshooting

1. **Connection Issues**

    - Verify network configuration (mainnet/testnet/emulator)
    - Check RPC endpoint availability
    - Ensure proper wallet configuration

2. **Transaction Failures**

    - Verify sufficient balance for transfers
    - Check correct address format (Flow vs EVM)
    - Confirm token contract compatibility

3. **Authentication Issues**
    - Validate private key format
    - Verify wallet address matches private key
    - Check network permissions

## Security Best Practices

1. **Key Management**

    - Store private keys securely
    - Use environment variables for sensitive data
    - Never expose private keys in code or logs

2. **Transaction Safety**
    - Validate all addresses before transfers
    - Implement proper error handling
    - Check token compatibility before transfers

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

## Future Enhancements

- Support for NFT transfers
- Enhanced error handling and recovery
- Additional Flow blockchain interactions
- Expanded token support

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Flow Blockchain](https://flow.com/): Decentralized layer 1 blockchain
- [@onflow/fcl](https://www.npmjs.com/package/@onflow/fcl): Flow Client Library
- [@onflow/types](https://www.npmjs.com/package/@onflow/types): Flow type system
- [Cadence](https://docs.onflow.org/cadence/): Smart contract programming language

Special thanks to:

- The Dapper Labs team for developing Flow
- The Flow Developer community
- The FCL SDK maintainers
- The Cadence language designers
- The Eliza community for their contributions and feedback

For more information about Flow capabilities:

- [Flow Documentation](https://docs.onflow.org/)
- [Flow Developer Portal](https://developers.flow.com/)
- [Flow Block Explorer](https://flowscan.io/)
- [Cadence Documentation](https://docs.onflow.org/cadence/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
