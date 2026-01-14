# Auto-Trader E2E Test Scenarios

This directory contains end-to-end test scenarios for the auto-trader plugin that simulate realistic trading interactions with the ElizaOS agent runtime.

## Test Suites

### 1. Agent Live Trading Scenario (`agent-live-trading-scenario.ts`)

A comprehensive test that simulates a full conversation flow between a user and the trading agent:

- Portfolio checking
- Market analysis
- Strategy configuration
- Live trading execution
- Performance monitoring
- Risk management

**Duration**: ~3 minutes  
**Requirements**: Real wallet with funds (for live mode) or mock mode enabled

### 2. Mock Trading Scenario (`mock-trading-scenario.ts`)

A development-friendly test suite that simulates trading without real funds:

- Full trading lifecycle with simulated prices
- Strategy comparison and backtesting
- No real wallet or funds required

**Duration**: ~1 minute  
**Requirements**: None (runs in mock mode)

### 3. Live Trading Scenarios (`liveTrading-scenarios.ts`)

Production-ready tests that execute real trades on Solana:

- 5-minute live trading test
- Quick 1-minute trading test
- Transaction verification on Solscan

**Duration**: 1-5 minutes  
**Requirements**:

- `SOLANA_PRIVATE_KEY` configured
- `BIRDEYE_API_KEY` configured
- Wallet with SOL and USDC

### 4. Auto Trading Scenarios (`autotrading-scenarios.ts`)

Basic functionality tests for the auto-trading system:

- Service initialization
- Strategy registration
- Trading lifecycle

## Running the Tests

### Run All E2E Tests

```bash
cd packages/plugin-auto-trader
elizaos test --e2e
```

### Run Specific Test Suite

```bash
# Run only mock trading scenarios (no real funds needed)
elizaos test --name "Mock Trading Scenarios"

# Run agent conversation scenarios
elizaos test --name "Agent Live Trading Scenario"

# Run live trading with real funds
elizaos test --name "Live Trading E2E Tests"
```

### Run Individual Test

```bash
# Run just the conversation flow test
elizaos test --name "Complete Trading Conversation Flow"

# Run just the risk management test
elizaos test --name "Risk Management Scenario"
```

## Environment Setup

### For Mock Testing (Recommended for Development)

No special setup required. Tests will automatically use mock services.

### For Live Trading Tests

Create a `.env` file in the plugin root:

```env
# Required for live trading
SOLANA_PRIVATE_KEY=your_wallet_private_key
BIRDEYE_API_KEY=your_birdeye_api_key

# Optional - defaults shown
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
JUPITER_API_URL=https://quote-api.jup.ag/v6

# Enable/disable wallet service
WALLET_SERVICE_ENABLED=true
```

## Test Scenarios Explained

### Complete Trading Conversation Flow

This test simulates a realistic conversation between a user and the trading agent:

1. **Portfolio Check**: User asks about their current holdings
2. **Market Analysis**: User requests analysis of specific tokens
3. **Strategy Configuration**: User sets up trading parameters
4. **Trading Execution**: User starts automated trading
5. **Monitoring**: Periodic status updates during trading
6. **Trade Discussion**: Agent explains executed trades
7. **Performance Review**: Final report and analysis

### Risk Management Scenario

Tests the agent's ability to handle risk limits:

1. Configures aggressive trading parameters
2. Sets a daily loss limit
3. Monitors for risk events
4. Verifies agent explains when limits are hit

### Mock Trading Features

The mock trading scenario provides:

- Simulated price movements (±5% volatility)
- Mock transaction generation
- Balance tracking
- Position management
- Realistic P&L calculations

## Output Files

Tests generate JSON files with detailed results:

- `agent_live_trading_scenario_results.json`: Full conversation logs and trade data
- `live_trading_e2e_results.json`: Transaction details and verification status

## Best Practices

1. **Start with Mock Tests**: Use mock scenarios for development and initial testing
2. **Small Amounts**: When testing live trading, use minimal amounts ($5-10)
3. **Monitor Closely**: Watch the console output during live tests
4. **Check Transactions**: Verify trades on Solscan using provided links
5. **Review Logs**: Check generated JSON files for detailed analysis

## Troubleshooting

### "Insufficient balance" Error

- Ensure your wallet has enough SOL for fees and USDC for trading
- Check that token accounts are initialized

### "Service not available" Error

- Verify all required services are registered in the plugin
- Check that dependencies are properly installed

### Mock Tests Not Working

- Ensure `USE_MOCK_EXCHANGE=true` is set in test environment
- Check that mock service overrides are properly applied

### Transaction Verification Fails

- Solscan may take 10-30 seconds to index new transactions
- The test retries verification 3 times with delays

## Contributing

When adding new test scenarios:

1. Use the `setupScenario` helper for consistent test environment
2. Use `sendMessageAndWaitForResponse` for agent interactions
3. Include meaningful assertions
4. Log important events to console
5. Save detailed results to JSON files
6. Handle both success and failure cases
