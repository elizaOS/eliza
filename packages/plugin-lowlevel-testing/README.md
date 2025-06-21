# @elizaos/plugin-lowlevel-testing

This plugin provides low-level testing for ElizaOS service implementations with actual API integrations.

## Installation

```bash
npm install @elizaos/plugin-lowlevel-testing
```

## Usage

```typescript
import { lowlevelTestingPlugin } from '@elizaos/plugin-lowlevel-testing';

// Add to your agent's plugins array
const agent = {
  plugins: [lowlevelTestingPlugin],
  // ... other agent config
};
```

## Test Structure

This plugin includes two types of tests:

### 1. Unit Tests
Located in `core_examplecoed/` - these are standard vitest unit tests that run in isolation.

To run unit tests:
```bash
bun run test:unit
# or
npm run test:unit
```

### 2. E2E Tests
Located in `src/tests/` - these are integration tests that require a live runtime with services.

The E2E tests include:
- `wallet-service.test.ts` - Tests wallet/account management service implementations
- `lp-service.test.ts` - Tests liquidity pool service implementations  
- `token-data-service.test.ts` - Tests token data fetching service implementations
- `token-creation-service.test.ts` - Tests token creation service implementations
- `swap-service.test.ts` - Tests swap/exchange service implementations
- `messaging-service.test.ts` - Tests messaging service implementations
- `dummy-services.test.ts` - Tests the dummy service implementations

## Known Issues

### E2E Tests Not Running
Currently, there's a bug in the ElizaOS test runner where it only checks `@elizaos/plugin-sql` for tests and doesn't iterate through all loaded plugins. This means the E2E tests in this plugin are not being discovered and run by `elizaos test`.

**Workaround**: The E2E tests are properly structured and will run once the test runner bug is fixed.

### Build Warnings
You may see TypeScript declaration build warnings. These don't affect runtime functionality.

## Dependencies

This plugin depends on:
- `@elizaos/core` - Core ElizaOS types and interfaces
- `@elizaos/plugin-dummy-services` - Provides dummy service implementations for testing

## Development

```bash
# Install dependencies
bun install

# Build the plugin
bun run build

# Run all tests
bun run test

# Run only unit tests
bun run test:unit
```

## Test Dependencies

The plugin automatically loads `@elizaos/plugin-dummy-services` as a test dependency to provide service implementations for testing.

## Overview

The Low-Level Testing Plugin is designed to test **real implementations** of standardized ElizaOS service interfaces. Unlike the dummy-services plugin which provides mock implementations for isolated testing, this plugin tests actual services with real API keys and connections.

## Purpose

This plugin serves as a comprehensive integration test suite that:

1. **Validates Service Compliance**: Ensures that real service implementations (EVM, Solana, DexScreener, etc.) correctly implement the standardized interfaces
2. **Tests Production Readiness**: Verifies that services work with actual API keys and real network connections
3. **Cross-Chain Validation**: Tests multiple blockchain implementations to ensure consistency
4. **Service Discovery**: Helps identify which services are available and properly registered

## Services Tested

### 1. IWalletService

Tests wallet implementations from:

- `@elizaos/plugin-evm` - EVM wallet operations
- `@elizaos/plugin-solana` - Solana wallet operations

**Methods tested:**

- `getPortfolio()` - Retrieve complete wallet portfolio
- `getBalance()` - Get balance for specific tokens
- `transferSol()` - Transfer SOL (Solana specific)

### 2. ILpService

Tests liquidity pool services from:

- `@elizaos/plugin-orca` - Orca DEX on Solana
- `@elizaos/plugin-raydium` - Raydium DEX on Solana
- `@elizaos/plugin-meteora` - Meteora DEX on Solana
- `@elizaos/plugin-uniswap` - Uniswap on EVM chains

**Methods tested:**

- `getPools()` - Fetch available liquidity pools
- `addLiquidity()` - Add liquidity to pools
- `removeLiquidity()` - Remove liquidity from pools
- `getLpPositionDetails()` - Get LP position information
- `getMarketDataForPools()` - Fetch market data (APY, TVL, etc.)

### 3. ITokenDataService

Tests token data providers from:

- `@elizaos/plugin-dexscreener` - DexScreener API
- `@elizaos/plugin-birdeye` - Birdeye API (if available)

**Methods tested:**

- `getTokenDetails()` - Get detailed token information
- `getTrendingTokens()` - Fetch trending tokens
- `searchTokens()` - Search for tokens by name/symbol
- `getTokensByAddresses()` - Batch fetch token data

### 4. ITokenCreationService

Tests token creation services from:

- `@elizaos/plugin-pumpfun` - Pump.fun token launcher

**Methods tested:**

- `createToken()` - Deploy new tokens
- `getTokenInfo()` - Retrieve token information
- `isReady()` - Check service readiness
- `getDeployerAddress()` - Get deployer wallet address

### 5. ISwapService

Tests swap/exchange services from:

- `@elizaos/plugin-jupiter` - Jupiter aggregator on Solana
- `@elizaos/plugin-uniswap` - Uniswap on EVM chains

**Methods tested:**

- `swap()` - Execute token swaps
- `getQuote()` - Get swap quotes
- `getSupportedTokens()` - List supported tokens

### 6. IMessageService / IPostService

Tests messaging services from:

- `@elizaos/plugin-discord` - Discord messaging
- `@elizaos/plugin-twitter` - Twitter/X posting

**Methods tested:**

- `sendMessage()` / `postTweet()` - Send messages/posts
- `replyToMessage()` / `replyToTweet()` - Reply functionality
- Service configuration and authentication

## Required Environment Variables

To run these tests successfully, you need to configure API keys and credentials:

```env
# EVM Configuration
EVM_PRIVATE_KEY=your_evm_private_key
EVM_RPC_URL=https://mainnet.infura.io/v3/your_infura_key

# Solana Configuration
SOLANA_PRIVATE_KEY=your_solana_private_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# DexScreener API
DEXSCREENER_API_KEY=your_dexscreener_key

# Birdeye API
BIRDEYE_API_KEY=your_birdeye_key

# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_APPLICATION_ID=your_discord_app_id

# Twitter
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_SECRET=your_twitter_access_secret

# Jupiter
JUPITER_API_KEY=your_jupiter_key (if required)

# Pump.fun
PUMPFUN_PRIVATE_KEY=your_pumpfun_wallet_key
```

## Example Test Output

```
Testing Low-Level Service Implementations...

✓ Wallet Service Real Implementation Tests
  ✓ EVM plugin loaded
  ✓ EVM wallet service active
  ✓ Portfolio retrieved: $1,234.56 total value
  ✓ Assets: 5 tokens
    - ETH: 0.5 ($1,150.00)
    - USDC: 100 ($100.00)
  ✓ ETH balance: 0.5 ETH
  ✓ USDC balance: 100 USDC
  ✓ EVM wallet address: 0x742d35Cc6634C0532925a3b844Bc9e7595f6E123

✓ LP Service Real Implementation Tests
  ✓ Found orca plugin
  ✓ orca LP service is active
  ✓ Found 156 pools on orca
  Sample pools:
    - SOL/USDC: TVL $5,234,567
    - mSOL/SOL: TVL $2,123,456
  ✓ Found 42 pools containing SOL
  ✓ Pool structure is valid

✓ Token Data Service Real Implementation Tests
  ✓ DexScreener plugin loaded
  ✓ Token data service found
  ✓ Retrieved data for SOL on solana
    Symbol: SOL
    Price: $123.45
    Market Cap: $45,678,901,234
  ✓ Found 10 trending tokens on solana
  ✓ Found 5 results for "USDC"

✓ Messaging Service Real Implementation Tests
  ✓ Discord plugin loaded
  ✓ Discord service registered
  ✓ Discord client is ready
    Bot: ElizaBot#1234
  ✓ Bot is in 3 guilds
```

## Development

### Adding New Service Tests

1. Create a new test file in `src/tests/`
2. Import the service interface from `@elizaos/core`
3. Load the plugins that implement the service
4. Write comprehensive tests for all interface methods
5. Add the test suite to the main plugin exports

### Best Practices

- Always check if a service is available before testing
- Handle API rate limits gracefully
- Log detailed information for debugging
- Test both success and failure cases
- Verify data types and formats
- Test with realistic data
- Skip tests that would cause side effects (posting, transferring funds)

## Troubleshooting

### Service Not Found

- Ensure the plugin is properly installed and imported
- Check that the plugin's `init` method registers the service
- Verify environment variables are set
- Check plugin dependencies

### API Errors

- Check API key validity
- Verify network connectivity
- Check rate limits
- Ensure sufficient balance for blockchain operations
- Verify you're on the correct network (mainnet vs testnet)

### Test Failures

- Review error logs for specific failure reasons
- Check if APIs have changed
- Verify test data is still valid
- Ensure dependencies are up to date
- Check service configuration

## Safety Considerations

This plugin tests real services with real API keys. To prevent unwanted side effects:

1. **No Real Transactions**: Tests verify methods exist but skip actual execution
2. **No Real Posts**: Messaging tests don't send actual messages
3. **Read-Only Operations**: Focus on querying data rather than modifying state
4. **Clear Warnings**: Tests clearly indicate when they skip operations

## Contributing

When adding support for new services:

1. Ensure they implement the standardized interface
2. Add comprehensive tests covering all methods
3. Document required environment variables
4. Add example outputs to this README
5. Test with multiple configurations
6. Consider rate limits and API costs

## Related Packages

- `@elizaos/plugin-dummy-services` - Mock implementations for isolated testing
- `@elizaos/core` - Core interfaces and types
- Individual plugin packages - Actual service implementations

## Future Enhancements

- [ ] Add performance benchmarking
- [ ] Test error recovery and retry logic
- [ ] Add network failure simulation
- [ ] Test concurrent operations
- [ ] Add cost estimation for API calls
- [ ] Create test report generation
- [ ] Add CI/CD integration examples
