# ElizaOS Polygon Plugin

This plugin provides integration with the Polygon blockchain network, allowing ElizaOS to interact with both Ethereum (L1) and Polygon (L2) networks.

## Features

- Account and balance management on both Ethereum and Polygon
- Token interactions (MATIC and ERC20 tokens)
- Governance interactions (proposals, voting, delegation)
- Staking operations (validators, delegation, rewards)
- Bridge operations between L1 and L2
- Block and transaction information retrieval
- **L1 to L2 token bridging** - Transfer tokens between Ethereum and Polygon
- Gas price estimation

## Configuration

The plugin requires the following configuration parameters:

| Parameter          | Description                                 | Required | Default                                                               |
| ------------------ | ------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `ETHEREUM_RPC_URL` | Ethereum (L1) JSON-RPC endpoint URL         | No       | https://mainnet.infura.io/v3/acc75dee85124d4db03ba3b3a9a9e3ab         |
| `POLYGON_RPC_URL`  | Polygon (L2) JSON-RPC endpoint URL          | No       | https://polygon-mainnet.infura.io/v3/acc75dee85124d4db03ba3b3a9a9e3ab |
| `PRIVATE_KEY`      | Private key for transaction signing         | Yes      | None                                                                  |
| `POLYGONSCAN_KEY`  | PolygonScan API key for gas estimations     | Yes      | None                                                                  |
| `GOVERNOR_ADDRESS` | Address of the governance contract          | No       | None                                                                  |
| `TOKEN_ADDRESS`    | Address of the governance token contract    | No       | None                                                                  |
| `TIMELOCK_ADDRESS` | Address of the timelock controller contract | No       | None                                                                  |

### RPC URL Configuration

The plugin now includes default RPC URLs for both Ethereum and Polygon networks. These defaults will be used if you don't provide your own URLs. However, for production use, it's recommended to provide your own RPC URLs to ensure reliable performance.

You can obtain RPC URLs from providers like:

- [Infura](https://infura.io/)
- [Alchemy](https://www.alchemy.com/)
- [QuickNode](https://www.quicknode.com/)
- [Ankr](https://www.ankr.com/)

## Recent Updates

### TypeScript Fixes (June 2024)

- Fixed TypeScript errors in the `PolygonRpcProvider` implementation
- Updated contract interaction methods to use `readContract` instead of `getContract` for better type safety
- Streamlined ethers.js imports to only include necessary types
- Improved error handling in RPC methods
- Added proper typing for ERC20 ABIs with `as const`

## Usage

Once configured, the plugin provides various actions for interacting with the Polygon network:

### Basic Information

- `GET_L2_BLOCK_NUMBER` - Get the current block number on Polygon
- `GET_L2_BLOCK_DETAILS` - Get detailed information about a specific block
- `GET_TRANSACTION_DETAILS` - Get detailed information about a specific transaction
- `GET_NATIVE_BALANCE` - Get MATIC balance for an address
- `GET_ERC20_BALANCE` - Get token balance for an address

### Transactions

- `TRANSFER_POLYGON` - Transfer MATIC or tokens on Polygon
- `BRIDGE_DEPOSIT` - Deposit assets from Ethereum to Polygon

### Staking and Governance

- `GET_VALIDATOR_INFO` - Get information about a validator
- `GET_DELEGATOR_INFO` - Get information about a delegator
- `DELEGATE_POLYGON` - Delegate MATIC to a validator
- `WITHDRAW_REWARDS` - Withdraw staking rewards
- `PROPOSE_GOVERNANCE` - Create a governance proposal
- `VOTE_GOVERNANCE` - Vote on a governance proposal
- `GET_GOVERNANCE_INFO` - Get information about governance proposals
- `GET_VOTING_POWER` - Get voting power for an address

## Bridging Ethereum to Polygon

The plugin supports bridging ERC20 tokens from Ethereum (L1) to Polygon (L2) using the official Polygon Bridge protocol.

### Using bridgeDeposit function

The `PolygonBridgeService` provides a `bridgeDeposit()` function that handles the complete bridge process:

```typescript
// Initialize the bridge service
const bridgeService = runtime.getService<PolygonBridgeService>(PolygonBridgeService.serviceType);

// Bridge tokens from L1 to L2
const result = await bridgeService.bridgeDeposit(
  '0xTokenAddressOnL1', // L1 ERC20 token address
  1000000000000000000n, // Amount in wei (1 token with 18 decimals)
  '0xRecipientAddressOnL2' // Optional: defaults to sender
);

console.log(`Bridge deposit initiated! Transaction: ${result.depositTxHash}`);
```

The function handles:

1. Approval of token spending by the RootChainManager contract
2. Deposit of tokens from L1 to L2
3. Gas estimation and transaction management

This is the recommended approach for programmatic bridging of tokens to Polygon.

### Bridge Deposit Action

The `BRIDGE_DEPOSIT_POLYGON` action provides a user-friendly interface for bridging tokens:

Examples:

- "Bridge 5 USDC from Ethereum to Polygon"
- "Send 0.5 POL to my Polygon address"
- "Transfer 10 LINK tokens from Ethereum to Polygon address 0x1234..."

The action will extract the token address, amount, and optional recipient from the user input.

## Development

To build the plugin:

```bash
npm run build
```

To run tests:

```

```
