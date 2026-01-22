import type { Plugin } from "@elizaos/core";
// Import test scenarios
import { autoTradingScenarios } from "./__tests__/e2e/autotrading-scenarios.ts";
import { liveTradingScenarios } from "./__tests__/e2e/liveTrading-scenarios.ts";
import { mockTradingScenarios } from "./__tests__/e2e/mock-trading-scenario.ts";
import { analyzePerformanceAction } from "./actions/analyzePerformanceAction.ts";
import { checkPortfolioAction } from "./actions/checkPortfolioAction.ts";
import { compareStrategiesAction } from "./actions/compareStrategiesAction.ts";
import { configureStrategyAction } from "./actions/configureStrategyAction.ts";
import { executeLiveTradeAction } from "./actions/executeLiveTradeAction.ts";
import { getMarketAnalysisAction } from "./actions/getMarketAnalysisAction.ts";
import { runBacktestAction } from "./actions/runBacktestAction.ts";
// Import actions
import { startTradingAction } from "./actions/startTradingAction.ts";
import { stopTradingAction } from "./actions/stopTradingAction.ts";
import { marketDataProvider } from "./providers/marketDataProvider.ts";
import { strategyProvider } from "./providers/strategyProvider.ts";

// Import providers
import { tradingProvider } from "./providers/tradingProvider.ts";
// Import services
import { AutoTradingManager } from "./services/AutoTradingManager.ts";
import { SwapService } from "./services/SwapService.ts";
import { TokenResolverService } from "./services/TokenResolverService.ts";
import { TokenValidationService } from "./services/TokenValidationService.ts";
import { TradingTrajectoryService } from "./services/TradingTrajectoryService.ts";

/**
 * Auto Trader Plugin
 *
 * Provides autonomous trading capabilities with:
 * - LLM-powered trading strategies
 * - Jupiter DEX integration for token swaps
 * - RugCheck token validation
 * - Risk management with stop-loss/take-profit
 * - Backtesting and paper trading modes
 */
const autoTraderPlugin: Plugin = {
  name: "plugin-auto-trader",
  description:
    "Autonomous trading plugin with LLM-powered strategies, Jupiter integration, and risk management",
  services: [
    AutoTradingManager,
    SwapService,
    TokenValidationService,
    TokenResolverService,
    TradingTrajectoryService,
  ],
  actions: [
    startTradingAction,
    stopTradingAction,
    checkPortfolioAction,
    runBacktestAction,
    compareStrategiesAction,
    analyzePerformanceAction,
    getMarketAnalysisAction,
    configureStrategyAction,
    executeLiveTradeAction,
  ],
  providers: [tradingProvider, marketDataProvider, strategyProvider],
  tests: [autoTradingScenarios, liveTradingScenarios, mockTradingScenarios],
};

export default autoTraderPlugin;
export { autoTraderPlugin };

export type {
  TradingConfig,
  TradingStatus,
} from "./services/AutoTradingManager.ts";
// Export services for direct access
export { AutoTradingManager } from "./services/AutoTradingManager.ts";
export type {
  SwapParams,
  SwapQuote,
  SwapResult,
  WalletBalance,
} from "./services/SwapService.ts";
export { KNOWN_TOKENS, SwapService } from "./services/SwapService.ts";
export type { TokenInfo } from "./services/TokenResolverService.ts";
export { TokenResolverService } from "./services/TokenResolverService.ts";
export type {
  RugCheckReport,
  TradingActivity,
  TradingRequirements,
  ValidationResult,
} from "./services/TokenValidationService.ts";
export { TokenValidationService } from "./services/TokenValidationService.ts";
export type { TradingEnvironmentState } from "./services/TradingTrajectoryService.ts";
export { TradingTrajectoryService } from "./services/TradingTrajectoryService.ts";
export type { LLMStrategyConfig } from "./strategies/LLMStrategy.ts";
// Export strategies
export { LLMStrategy } from "./strategies/LLMStrategy.ts";
export { MeanReversionStrategy } from "./strategies/MeanReversionStrategy.ts";
export { MomentumBreakoutStrategy } from "./strategies/MomentumBreakoutStrategy.ts";
export { RandomStrategy } from "./strategies/RandomStrategy.ts";
export { RuleBasedStrategy } from "./strategies/RuleBasedStrategy.ts";
// Export types from trading.ts (excluding TradingConfig which is also in AutoTradingManager)
export type { RiskLimits, WalletPortfolioItem } from "./types/trading.ts";
// Re-export TradingConfig from trading.ts as TradingSettings to avoid conflict
export type { TradingConfig as TradingSettings } from "./types/trading.ts";
// Export types - these include PortfolioAssetHolding and WalletPortfolio
export * from "./types.ts";
