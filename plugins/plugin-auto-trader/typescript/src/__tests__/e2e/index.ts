import type { TestSuite } from '@elizaos/core';
import autoTradingScenarios from './autotrading-scenarios.ts';
import liveTradingScenarios from './liveTrading-scenarios.ts';
import agentLiveTradingScenario from './agent-live-trading-scenario.ts';
import mockTradingScenario from './mock-trading-scenario.ts';

export const testSuites: TestSuite[] = [
  autoTradingScenarios,
  liveTradingScenarios,
  agentLiveTradingScenario,
  mockTradingScenario,
];

export default testSuites;

// Export all E2E test scenarios
export { autoTradingScenarios } from './autotrading-scenarios.ts';
export { liveTradingScenarios } from './liveTrading-scenarios.ts';
export { mockTradingScenarios } from './mock-trading-scenario.ts';

// Export test utilities
export * from './test-utils.ts';
