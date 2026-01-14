# ElizaOS AutoTrader Plugin (`plugin-auto-trader`)

## 1. Overview

The `plugin-auto-trader` is an ElizaOS plugin designed to provide autonomous and configurable cryptocurrency trading capabilities. It allows agents to execute trading strategies, simulate these strategies against historical data, and analyze their performance.

This plugin is built with a modular approach, enabling the easy addition of new trading strategies and data sources.

## 2. Key Features

*   **Pluggable Trading Strategy Framework:**
    *   A core `TradingStrategy` interface that all strategies implement.
    *   `StrategyRegistryService` for discovering and managing available strategies.
*   **Implemented Trading Strategies:**
    *   **`RandomStrategy`**: Makes random buy/sell decisions. Useful as a baseline.
        *   Configurable: `tradeAttemptProbability`, `buyProbability`, `maxTradeSizePercentage`, `fixedTradeQuantity`.
    *   **`RuleBasedStrategy`**: Executes trades based on technical indicators and market conditions.
        *   Configurable: A list of `RuleCondition` objects (RSI, SMA/EMA Crossover, Volume triggers), stop-loss/take-profit settings, trade sizing.
        *   *Note: Currently uses mock calculations for TI. Integration with a library like `technicalindicators` is planned.*
    *   **`LLMStrategy`**: Leverages a Large Language Model (LLM) to make trading decisions.
        *   Configurable: `modelName`, `systemPrompt`, `customPromptPrefix/Suffix`, trade sizing defaults.
        *   Builds a detailed prompt based on market data and agent state.
        *   Parses JSON responses from the LLM.
        *   *Note: Requires integration with a core ElizaOS LLM service.*
*   **Simulation Engine:**
    *   **`HistoricalDataService`**: Fetches and caches historical OHLCV data.
        *   Supports a `mockSource` for testing and a conceptual `birdeye` API integration (requires `BIRDEYE_API_KEY` environment variable).
        *   Conceptual filesystem-based caching (actual file I/O is placeholder).
    *   **`SimulationService`**: Runs backtests of trading strategies against historical data.
        *   Simulates trade execution, including transaction costs and basic slippage.
        *   Tracks portfolio value, P&L (including realized P&L per closing trade), and individual trades.
*   **Benchmarking & Reporting:**
    *   **`PerformanceReportingService`**: Generates detailed performance reports (`SimulationReport`).
    *   Calculates key metrics: Total P&L (absolute and percentage), Win/Loss Ratio, Average Win/Loss size, Max Drawdown, Total Trades, Buy & Hold P&L benchmark.
    *   *Note: Advanced metrics like Sharpe/Sortino Ratio are placeholders.*

## 3. Installation & Setup (Conceptual)

This plugin is intended to be part of the ElizaOS ecosystem.

1.  Ensure `plugin-auto-trader` is included in your ElizaOS plugins directory.
2.  The plugin will be initialized during ElizaOS startup via its `src/index.ts` (`initializePlugin` function).
3.  **API Keys (Required for some features):**
    *   For Birdeye data via `HistoricalDataService`: Set the `BIRDEYE_API_KEY` environment variable.
4.  **External Libraries (Future):**
    *   When `RuleBasedStrategy` is updated to use a real Technical Indicators library (e.g., `technicalindicators`), it will need to be installed: `npm install technicalindicators` (or `bun install`).

## 4. How to Use (Conceptual - via direct service calls for now)

Currently, interaction with the plugin's services would typically be done programmatically within another ElizaOS plugin or service that has access to the auto-trader's registered services.

### 4.1. Accessing Services

Services are registered with ElizaOS runtime (conceptually) during plugin initialization. You would typically retrieve them using `runtime.getService('serviceName')`:

*   `runtime.getService('auto-trader/StrategyRegistryService')`
*   `runtime.getService('auto-trader/HistoricalDataService')`
*   `runtime.getService('auto-trader/SimulationService')`
*   `runtime.getService('auto-trader/PerformanceReportingService')`

*(Note: The exact service names depend on the runtime's registration mechanism. The plugin currently attempts to register service classes.)*

### 4.2. Listing Available Strategies

```typescript
// const strategyRegistry = runtime.getService('auto-trader/StrategyRegistryService') as StrategyRegistryService;
// const strategies = strategyRegistry.listStrategies();
// console.log(strategies.map(s => s.name));
```

### 4.3. Running a Simulation

Use the `SimulationService` to run a backtest:

```typescript
// const simulationService = runtime.getService('auto-trader/SimulationService') as SimulationService;
// const historicalDataService = runtime.getService('auto-trader/HistoricalDataService') as DefaultHistoricalDataService;
// const strategyRegistry = runtime.getService('auto-trader/StrategyRegistryService') as StrategyRegistryService;
// const performanceReporting = new PerformanceReportingService(); // Or get from runtime if stateful

// Ensure services are available, then:
// const simService = new SimulationService(strategyRegistry, historicalDataService, performanceReporting);

const simulationParams = {
  strategyId: 'random-v1', // or 'rule-based-v1', 'llm-v1'
  strategyParams: {
    // Strategy-specific parameters, e.g., for RandomStrategy:
    tradeAttemptProbability: 0.5,
    buyProbability: 0.6,
    fixedTradeQuantity: 2,
    // e.g., for RuleBasedStrategy:
    // rules: [{ type: 'RSI', rsiPeriod: 14, rsiOversold: 30, action: 'BUY' }],
    // stopLossTakeProfit: { stopLossPercentage: 0.05 }
  },
  symbol: 'SOL/USDC', // Use a token address for Birdeye, e.g., 'So11111111111111111111111111111111111111112'
  timeframe: '1h',
  startDate: new Date('2023-01-01T00:00:00Z'),
  endDate: new Date('2023-03-01T00:00:00Z'),
  initialCapital: 10000,
  transactionCostPercentage: 0.001, // 0.1%
  slippagePercentage: { marketOrder: 0.0005 }, // 0.05%
  dataApiSource: 'mockSource', // or 'birdeye' (if API key is set)
};

// async function runTestSimulation() {
//   try {
//     const report = await simulationService.runBacktest(simulationParams);
//     console.log('Simulation Report:', JSON.stringify(report, null, 2));
//     console.log('P&L:', report.metrics.totalPnlPercentage * 100, '%');
//     console.log('Buy & Hold P&L:', report.metrics.buyAndHoldPnlPercentage * 100, '%');
//   } catch (error) {
//     console.error('Simulation failed:', error);
//   }
// }
// runTestSimulation();
```

### 4.4. Strategy Configuration Parameters

*   **`RandomStrategyParams`**: `tradeAttemptProbability`, `buyProbability`, `maxTradeSizePercentage`, `fixedTradeQuantity`.
*   **`RuleBasedStrategyParams`**: `rules` (array of `RuleCondition`), `stopLossTakeProfit`, `tradeSizePercentage`, `fixedTradeQuantity`, `minIndicatorDataPoints`.
    *   `RuleCondition`: `type` (`RSI`, `SMA_CROSSOVER`, etc.), `action` (`BUY`/`SELL`), and type-specific params (e.g., `rsiPeriod`, `shortMAPeriod`, `longMAPeriod`, `maType`).
*   **`LLMStrategyParams`**: `modelName`, `systemPrompt`, `customPromptPrefix`, `customPromptSuffix`, `maxTokens`, `temperature`, `defaultTradeSizePercentage`, `defaultFixedTradeQuantity`, `structuredOutputSchema`.

## 5. Current Limitations & Placeholders

*   **Real Data Source Integration**: `HistoricalDataService` currently uses mock data for most sources. Birdeye integration is conceptual and requires a valid API key. Full implementation of other sources (CoinMarketCap, Jupiter, CCXT) is pending.
*   **Real Technical Indicators**: `RuleBasedStrategy` uses mock calculations for technical indicators. It needs to be integrated with a library like `technicalindicators`.
*   **Real LLM Service**: `LLMStrategy` requires integration with a functional ElizaOS core LLM service.
*   **Order Execution Service**: No real implementation for live/paper trading yet; only simulation.
*   **Advanced Metrics**: Sharpe Ratio, Sortino Ratio, and other advanced financial metrics are placeholders.
*   **Filesystem Cache**: The filesystem cache in `HistoricalDataService` is conceptual; actual file I/O operations are commented out.

## 6. Future Enhancements (from original spec)

*   More sophisticated strategies (arbitrage, ML-based).
*   Portfolio-level strategies.
*   Walk-forward optimization.
*   Live paper trading & real money trading.
*   Strategy marketplace integration.
*   Visual backtesting tools.

This README provides a starting point and will be updated as the plugin evolves.
