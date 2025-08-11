# ElizaOS Polygon Plugin

This plugin provides integration with the Polygon blockchain network, allowing ElizaOS to interact with both Ethereum (L1) and Polygon (L2) networks.

## Features

- **L1 & L2 RPC Support**: Connect to both Ethereum (L1) and Polygon (L2) networks
- **Staking Operations**:
  - Delegate MATIC to validators
  - Query validator details
  - Check delegation information
  - Withdraw staking rewards
  - Restake rewards
- **Bridging**: Transfer tokens between Ethereum L1 and Polygon L2
- **Checkpoint Status**: Verify if L2 blocks have been checkpointed to L1
- **Token Swaps**: Swap tokens on Polygon using LiFi integration

## Installation

```bash
# Install the plugin in your ElizaOS project
npm install @elizaos/plugin-polygon
```

## Configuration

Create a `.env` file with the following variables (see `env.example` for reference):

```
# Required RPC URLs
POLYGON_RPC_URL=https://polygon-rpc.com
ETHEREUM_RPC_URL=https://ethereum.infura.io/v3/YOUR_KEY

# Required for wallet operations
PRIVATE_KEY=your_private_key_here

# Optional: API key for gas estimations
POLYGONSCAN_KEY=your_polygonscan_api_key

# Enable the plugin
POLYGON_PLUGINS_ENABLED=true
```

### Advanced Configuration

For monitoring Polygon validator operations (read-only):

```
HEIMDALL_RPC_URL=https://polygon-heimdall-rpc.publicnode.com:443
```

**Note**: After extensive analysis, we determined that Heimdall's modified Cosmos SDK does not support general token transfers or governance operations for external users. See `HEIMDALL_ANALYSIS.md` for detailed findings. Heimdall is a specialized validator consensus layer, not a general-purpose blockchain.

## Available Actions

### DELEGATE_POLYGON

Delegates (stakes) MATIC tokens to a validator on the Polygon network.

**Example query:**

```
Delegate 10 MATIC to validator ID 123
```

### GET_VALIDATOR_INFO

Retrieves information about a specific Polygon validator.

**Example query:**

```
Show details for Polygon validator 42
```

**Response includes:**

- Validator status
- Total staked amount
- Commission rate
- Signer address
- Contract address

### GET_DELEGATOR_INFO

Retrieves staking information for a specific delegator address (defaults to agent wallet).

**Example query:**

```
Show my delegation details for validator 123
```

**Response includes:**

- Delegated amount
- Pending rewards

### GET_CHECKPOINT_STATUS

Checks if a Polygon L2 block has been checkpointed to Ethereum L1.

**Example query:**

```
Check if Polygon block 42000000 has been checkpointed
```

### SWAP_POLYGON_TOKENS

Swaps tokens on Polygon using LiFi integration.

**Example query:**

```
Swap 100 USDC for DAI on Polygon with 0.3% slippage
```

### HEIMDALL_TRANSFER_TOKENS

Transfers native tokens on the Heimdall network.

**Example query:**

```
Transfer 1000000000000000000 matic to heimdall1abc...
```

## Features

- Account and balance management on both Ethereum and Polygon
- Token interactions (MATIC and ERC20 tokens)
- Staking operations (validators, delegation, rewards)
- Bridge operations between L1 and L2
- Block and transaction information retrieval
- **L1 to L2 token bridging** - Transfer tokens between Ethereum and Polygon
- **Heimdall token transfers** - Transfer tokens on the Heimdall network
- Gas price estimation

## Testing

### Standardized Test Mocks

This plugin uses a centralized approach to mocking for tests. All mock definitions are kept in `vitest.setup.ts` to ensure consistency across test files.

Key features of the testing approach:

1. **Centralized Mocks**: All shared mocks are defined in `vitest.setup.ts`
2. **Standardized Ethers Mocks**: Consistent mocks for ethers.js contracts and providers
3. **Standardized Viem Mocks**: Consistent mocks for viem clients and utilities
4. **Standardized Runtime Mock**: A consistent mock for the ElizaOS runtime

When writing tests:

1. Import mocks from `vitest.setup.ts` rather than creating local duplicates
2. Customize the shared mocks for your specific test scenarios
3. For service tests, use the shared contract mocks to ensure consistent behavior
4. For action tests, use the shared service mocks rather than creating local duplicates

Example:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YourAction } from '../../src/actions/yourAction';
import { mockRuntime, mockPolygonRpcService } from '../../vitest.setup';

describe('YourAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Customize the centralized mock for your test
    mockPolygonRpcService.someMethod = vi.fn().mockResolvedValue('result');

    // Configure runtime to return the service
    vi.spyOn(mockRuntime, 'getService').mockImplementation((serviceType) => {
      if (serviceType === 'PolygonRpcService') return mockPolygonRpcService;
      return null;
    });
  });

  it('should perform expected behavior', async () => {
    // Your test using the centralized mocks
  });
});
```

## Troubleshooting

### Common Issues

1. **RPC Connection Errors**

   - Ensure your `ETHEREUM_RPC_URL` and `POLYGON_RPC_URL` are valid and accessible
   - Check for rate limiting if using free tier RPC providers

2. **Transaction Failures**

   - Insufficient funds: Ensure your wallet has enough MATIC/ETH for gas
   - Gas estimation failures: Try setting a manual gas limit or using a higher gas price

3. **Validator Not Found**
   - Verify the validator ID exists and is active on the network

### Debug Mode

Enable debug logging by setting:

```
LOG_LEVEL=debug
```

## License

MIT
