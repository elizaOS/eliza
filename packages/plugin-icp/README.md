# @elizaos/plugin-icp

Internet Computer Protocol (ICP) plugin for Eliza OS.

## Features

- Create meme tokens on PickPump
- Interact with ICP canisters
- Handle ICRC-1 token standard
- Manage ICP wallets and identities
- Support for anonymous and authenticated calls

## Installation

```bash
pnpm install @elizaos/plugin-icp
```

## Configuration

The plugin requires the following environment variables:

```env
INTERNET_COMPUTER_PRIVATE_KEY=<your-ed25519-private-key>
```

## Usage

### Import and Register

```typescript
import { icpPlugin } from '@elizaos/plugin-icp';

// Register the plugin with Eliza
eliza.registerPlugin(icpPlugin);
```

### Available Actions

#### Create Token
Creates a new meme token on PickPump with AI-generated logo and description.

```typescript
// Example usage in chat
"Create a space cat token on PickPump"
"Help me create a pizza-themed funny token on PP"
```

### Providers

#### ICP Wallet Provider
Manages ICP wallet operations and canister interactions.

```typescript
const { wallet } = await icpWalletProvider.get(runtime, message, state);
```

## Common Issues & Troubleshooting

1. **Identity Creation Failures**
   - Ensure private key is exactly 32 bytes
   - Verify private key is properly hex-encoded
   - Check if private key has correct permissions

2. **Canister Interaction Issues**
   - Verify canister ID is valid
   - Ensure proper network configuration (mainnet/testnet)
   - Check if canister is available and running

3. **Transaction Failures**
   - Verify sufficient balance for operation
   - Check cycle balance for canister calls
   - Ensure proper fee calculation

4. **Authentication Problems**
   - Verify identity is properly initialized
   - Check if agent is configured correctly
   - Ensure proper network connectivity

## Security Best Practices

1. **Key Management**
   - Never expose private keys in code or logs
   - Use environment variables for sensitive data
   - Rotate keys periodically
   - Use separate keys for development and production

2. **Identity Security**
   - Create separate identities for different purposes
   - Limit identity permissions appropriately
   - Monitor identity usage and access patterns

3. **Canister Interaction Safety**
   - Validate all input parameters
   - Implement proper error handling
   - Use query calls when possible to save cycles
   - Implement rate limiting for calls

4. **Network Security**
   - Use secure endpoints
   - Implement proper timeout handling
   - Validate responses from canisters
   - Handle network errors gracefully

## API Reference

### Types

```typescript
// Token Creation Arguments
export type CreateMemeTokenArg = {
    name: string;
    symbol: string;
    description: string;
    logo: string;
    twitter?: string;
    website?: string;
    telegram?: string;
};

// ICP Configuration
export interface ICPConfig {
    privateKey: string;
    network?: "mainnet" | "testnet";
}
```

### Utilities

The plugin provides various utility functions for:
- Principal/Account conversions
- Candid type handling
- Result/Variant unwrapping
- Array/Hex conversions

### Helper Functions

```typescript
// Convert principal to account
principal2account(principal: string, subaccount?: number[]): string

// Check if text is valid principal
isPrincipalText(text: string): boolean

// Create anonymous actor for public queries
createAnonymousActor<T>(idlFactory, canisterId, host?)
```

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

### Testing with Local Replica

1. Start a local Internet Computer replica
2. Configure environment for local testing
3. Use test identities for development

## Dependencies

- @dfinity/agent: ^2.1.3
- @dfinity/candid: ^2.1.3
- @dfinity/identity: ^2.1.3
- @dfinity/principal: ^2.1.3
- @elizaos/core: workspace:*

## Future Enhancements

- Support for additional canister standards
- Enhanced error handling and recovery
- Batch transaction support
- Advanced identity management
- Improved cycle management
- Extended canister interaction capabilities

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Internet Computer](https://internetcomputer.org/): Decentralized cloud computing platform
- [@dfinity/agent](https://www.npmjs.com/package/@dfinity/agent): ICP HTTP client and agent
- [@dfinity/candid](https://www.npmjs.com/package/@dfinity/candid): Candid interface description language
- [@dfinity/principal](https://www.npmjs.com/package/@dfinity/principal): Principal identifier handling
- [@dfinity/identity](https://www.npmjs.com/package/@dfinity/identity): Identity management

Special thanks to:
- The DFINITY Foundation for developing the Internet Computer
- The ICP Developer community
- The DFINITY SDK maintainers
- The PickPump team for meme token infrastructure
- The Eliza community for their contributions and feedback

For more information about Internet Computer capabilities:
- [ICP Documentation](https://internetcomputer.org/docs/)
- [DFINITY Developer Portal](https://smartcontracts.org/)
- [ICP Dashboard](https://dashboard.internetcomputer.org/)
- [Candid Documentation](https://internetcomputer.org/docs/current/developer-docs/build/candid/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

