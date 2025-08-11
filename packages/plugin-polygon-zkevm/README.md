# Project Starter

This is the starter template for ElizaOS projects.

## Features

- Pre-configured project structure for ElizaOS development
- Comprehensive testing setup with component and e2e tests
- Default character configuration with plugin integration
- Example service, action, and provider implementations
- TypeScript configuration for optimal developer experience
- Built-in documentation and examples

## Getting Started

```bash
# Clone the starter project
npx elizaos create my-project

# Navigate to the project directory
cd my-project

# Install dependencies
npm install

# Start development server
npm run dev
```

## Development

```bash
# Start development server
npm run dev

# Build the project
npm run build

# Test the project
npm run test
```

## Testing

ElizaOS provides a comprehensive testing structure for projects:

### Test Structure

- **Component Tests** (`__tests__/` directory):

  - **Unit Tests**: Test individual functions and components in isolation
  - **Integration Tests**: Test how components work together
  - Run with: `npm run test:component`

- **End-to-End Tests** (`e2e/` directory):

  - Test the project within a full ElizaOS runtime
  - Run with: `npm run test:e2e`

- **Running All Tests**:
  - `npm run test` runs both component and e2e tests

### Writing Tests

Component tests use Vitest:

```typescript
// Unit test example (__tests__/config.test.ts)
describe('Configuration', () => {
  it('should load configuration correctly', () => {
    expect(config.debug).toBeDefined();
  });
});

// Integration test example (__tests__/integration.test.ts)
describe('Integration: Plugin with Character', () => {
  it('should initialize character with plugins', async () => {
    // Test interactions between components
  });
});
```

E2E tests use ElizaOS test interface:

```typescript
// E2E test example (e2e/project.test.ts)
export class ProjectTestSuite implements TestSuite {
  name = 'project_test_suite';
  tests = [
    {
      name: 'project_initialization',
      fn: async (runtime) => {
        // Test project in a real runtime
      },
    },
  ];
}

export default new ProjectTestSuite();
```

The test utilities in `__tests__/utils/` provide helper functions to simplify writing tests.

## Configuration

Customize your project by modifying:

- `src/index.ts` - Main entry point
- `src/character.ts` - Character definition
- `src/plugin.ts` - Plugin configuration

# Polygon zkEVM Plugin

A plugin for interacting with Polygon zkEVM blockchain through Eliza.

## Features

- Get current block number
- Get account balances
- Get transaction details and receipts
- Get gas price estimates
- Estimate gas for transactions
- Get contract code and storage
- Get transaction logs
- Check block status
- Get batch information
- **Deploy smart contracts**
- **Bridge assets between Ethereum and Polygon zkEVM** (NEW)
- Block information and status queries
- Transaction details and receipts
- Account balance checking
- Gas price estimation and analysis
- Smart contract deployment
- Smart contract interaction
- Asset bridging between Ethereum and Polygon zkEVM
- Message bridging between networks
- Transaction fee estimation
- Batch information queries

## Configuration

The plugin requires configuration through environment variables or runtime settings:

### Required Settings

For read-only operations:

- `ALCHEMY_API_KEY` OR `ZKEVM_RPC_URL`: At least one endpoint must be configured

For write operations (like contract deployment):

- `PRIVATE_KEY`: Your wallet's private key for signing transactions
- `ALCHEMY_API_KEY` OR `ZKEVM_RPC_URL`: At least one endpoint must be configured

### Environment Variables

The plugin supports environment variable fallbacks for all configuration:

```bash
# Alchemy API (recommended)
ALCHEMY_API_KEY=your_alchemy_api_key

# Direct RPC endpoint (fallback)
ZKEVM_RPC_URL=https://polygonzkevm-mainnet.g.alchemy.com/v2

# Private key for write operations
PRIVATE_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

### Runtime Settings

Alternatively, you can configure these through the Eliza runtime:

```typescript
runtime.setSetting('ALCHEMY_API_KEY', 'your_alchemy_api_key');
runtime.setSetting('ZKEVM_RPC_URL', 'https://polygonzkevm-mainnet.g.alchemy.com/v2');
runtime.setSetting('PRIVATE_KEY', '0x1234567890abcdef...');
```

**Note**: Runtime settings take precedence over environment variables.

## Actions

### Bridge Assets

Bridge ETH or ERC-20 tokens between Ethereum and Polygon zkEVM.

**Action Name**: `BRIDGE_ASSETS`
**Aliases**: `BRIDGE_TOKENS`, `DEPOSIT_ASSETS`, `WITHDRAW_ASSETS`, `BRIDGE_ETH`, `BRIDGE_ERC20`

**Requirements**:

- `PRIVATE_KEY` must be configured
- `ALCHEMY_API_KEY` or `ZKEVM_RPC_URL` must be configured

**Supported Operations**:

- **Deposit**: Transfer assets from Ethereum mainnet to Polygon zkEVM
- **Withdraw**: Transfer assets from Polygon zkEVM to Ethereum mainnet

**Usage Examples**:

```
bridge 0.1 ETH from ethereum to polygon zkevm
deposit 100 USDC to polygon zkevm
withdraw 50 USDT from polygon zkevm to ethereum
bridge 1000 tokens at 0x1234567890123456789012345678901234567890 from ethereum to zkevm
```

**Parameters**:

- `tokenAddress`: Contract address for ERC-20 tokens (use `null` or omit for ETH)
- `amount`: Amount to bridge (e.g., "0.1", "100")
- `direction`: Either "deposit" (L1→L2) or "withdraw" (L2→L1)
- `gasLimit`: Optional gas limit override
- `gasPrice`: Optional gas price in gwei
- `maxFeePerGas`: Optional max fee per gas for EIP-1559 transactions
- `maxPriorityFeePerGas`: Optional priority fee for EIP-1559 transactions

**Bridge Process**:

1. **Deposits (Ethereum → zkEVM)**:

   - Assets are locked on Ethereum mainnet
   - Equivalent assets are minted on Polygon zkEVM
   - Process typically takes a few minutes
   - Auto-claiming is enabled by default

2. **Withdrawals (zkEVM → Ethereum)**:
   - Assets are burned on Polygon zkEVM
   - Must wait for challenge period (typically 7 days)
   - Manual claim required on Ethereum mainnet after challenge period

**Response Data**:

- `txHash`: Transaction hash of the bridge operation
- `bridgeTicketId`: Unique bridge ticket identifier for tracking
- `direction`: Bridge direction (deposit/withdraw)
- `sourceNetwork`: Source blockchain network
- `destinationNetwork`: Destination blockchain network
- `gasUsed`: Gas consumed by the transaction
- `blockNumber`: Block number where transaction was included

### Deploy Smart Contract

Deploy arbitrary smart contract bytecode to Polygon zkEVM.

**Action Name**: `DEPLOY_SMART_CONTRACT`
**Aliases**: `DEPLOY_CONTRACT`, `DEPLOY_ZKEVM_CONTRACT`, `CREATE_CONTRACT`

**Requirements**:

- `PRIVATE_KEY` must be configured
- `ALCHEMY_API_KEY` or `ZKEVM_RPC_URL` must be configured

**Usage Examples**:

```
deploy smart contract with bytecode 0x608060405234801561001057600080fd5b50...
deploy contract with bytecode 0x608060405234801561001057600080fd5b50... and constructor args ["Hello World", 1000]
deploy contract with bytecode 0x608060405234801561001057600080fd5b50... with gas limit 2000000
```

## Security

- **Never expose your private key** in logs, code, or version control
- Use environment variables or secure runtime configuration for sensitive data
- Validate all contract bytecode before deployment
- Test deployments on testnets before mainnet

## Testing

Run tests with:

```bash
npm test
```

For specific test files:

```bash
npm test -- deploySmartContract.test.ts
```

### Gas and Fee Estimation

#### `ESTIMATE_TRANSACTION_FEE`

Estimates gas limit and total fee for transaction payloads on Polygon zkEVM.

**Features:**

- Supports both ETH transfers and contract calls
- Uses Alchemy API with fallback to JSON-RPC
- Allows priority fee override
- Returns structured data: `{ gasLimit: string, fee: string }`
- Accurate fee calculation within network tolerance

**Usage:**

- "Estimate fee for sending 0.1 ETH to 0x742d35Cc6634C0532925A3B8D4C9dB96C4B4d8B6"
- "Calculate transaction fee with priority fee of 25 gwei"
- "How much will it cost to call contract at 0x..."

**Response format:**

```json
{
  "gasLimit": "21000",
  "fee": "420000000000000",
  "gasPrice": "20000000000",
  "gasPriceGwei": "20",
  "totalFeeEth": "0.00042",
  "transaction": {...},
  "network": "polygon-zkevm"
}
```
