/**
 * A2A Load Test Scenarios
 *
 * Test scenarios for Agent-to-Agent (A2A) protocol endpoints
 * to stress test rate limiting and performance under load.
 */

import type { JsonRpcParams } from '@feed/a2a';
import type { LoadTestConfig } from './load-test-simulator';

/**
 * Generate A2A request body for a given method
 */
export function generateA2ARequest(method: string, params?: JsonRpcParams) {
  return {
    jsonrpc: '2.0',
    method,
    params: params || {},
    id: Math.floor(Math.random() * 1000000),
  };
}

/**
 * Common A2A headers for agent authentication
 */
export function getA2AHeaders(agentId = 'test-agent-1') {
  return {
    'Content-Type': 'application/json',
    'x-agent-id': agentId,
    'x-agent-address': '0x1234567890123456789012345678901234567890',
    'x-agent-token-id': '1',
  };
}

/**
 * All implemented A2A methods with their parameters
 * NOTE: A2A protocol currently implements 10 core methods
 */
export const A2A_METHODS = {
  // Agent Discovery (2)
  DISCOVER: { method: 'a2a.discover', params: {} },
  GET_INFO: { method: 'a2a.getInfo', params: { agentId: 'feed-agent' } },

  // Market Operations (3)
  GET_MARKET_DATA: { method: 'a2a.getMarketData', params: { marketId: '1' } },
  GET_MARKET_PRICES: {
    method: 'a2a.getMarketPrices',
    params: { marketIds: ['1', '2'] as string[] },
  },
  SUBSCRIBE_MARKET: {
    method: 'a2a.subscribeMarket',
    params: { marketId: '1' },
  },

  // Portfolio (3)
  GET_BALANCE: { method: 'a2a.getBalance', params: {} },
  GET_POSITIONS: { method: 'a2a.getPositions', params: {} },
  GET_USER_WALLET: {
    method: 'a2a.getUserWallet',
    params: { userId: 'user-1' },
  },

  // Payments (2)
  PAYMENT_REQUEST: {
    method: 'a2a.paymentRequest',
    params: { to: '0x...', amount: '1000000', service: 'test' },
  },
  PAYMENT_RECEIPT: {
    method: 'a2a.paymentReceipt',
    params: { requestId: 'req-1', txHash: '0x...' },
  },
} as const;

/**
 * Generate endpoint configuration for load testing
 */
function generateA2AEndpoint(
  methodConfig: { method: string; params: JsonRpcParams },
  weight: number,
  agentId = 'test-agent-1'
) {
  return {
    path: '/api/a2a',
    method: 'POST' as const,
    weight,
    headers: getA2AHeaders(agentId),
    body: generateA2ARequest(methodConfig.method, methodConfig.params),
  };
}

/**
 * Light A2A load test: 50 agents, focus on read operations
 */
export const A2A_LIGHT_SCENARIO: LoadTestConfig = {
  concurrentUsers: 50,
  durationSeconds: 60,
  rampUpSeconds: 10,
  thinkTimeMs: 1000,
  endpoints: [
    generateA2AEndpoint(A2A_METHODS.GET_BALANCE, 0.3),
    generateA2AEndpoint(A2A_METHODS.GET_POSITIONS, 0.25),
    generateA2AEndpoint(A2A_METHODS.GET_MARKET_DATA, 0.25),
    generateA2AEndpoint(A2A_METHODS.GET_USER_WALLET, 0.2),
  ],
};

/**
 * Normal A2A load test: 100 agents, mixed operations
 */
export const A2A_NORMAL_SCENARIO: LoadTestConfig = {
  concurrentUsers: 100,
  durationSeconds: 120,
  rampUpSeconds: 20,
  thinkTimeMs: 500,
  endpoints: [
    generateA2AEndpoint(A2A_METHODS.GET_BALANCE, 0.2),
    generateA2AEndpoint(A2A_METHODS.GET_POSITIONS, 0.2),
    generateA2AEndpoint(A2A_METHODS.GET_MARKET_DATA, 0.15),
    generateA2AEndpoint(A2A_METHODS.SUBSCRIBE_MARKET, 0.1),
    generateA2AEndpoint(A2A_METHODS.GET_USER_WALLET, 0.1),
    generateA2AEndpoint(A2A_METHODS.DISCOVER, 0.05),
    generateA2AEndpoint(A2A_METHODS.GET_INFO, 0.05),
  ],
};

/**
 * Heavy A2A load test: 200 agents, stress test all endpoints
 */
export const A2A_HEAVY_SCENARIO: LoadTestConfig = {
  concurrentUsers: 200,
  durationSeconds: 300,
  rampUpSeconds: 30,
  thinkTimeMs: 200,
  maxRps: 500,
  endpoints: [
    // Agent Discovery
    generateA2AEndpoint(A2A_METHODS.DISCOVER, 0.1),
    generateA2AEndpoint(A2A_METHODS.GET_INFO, 0.1),

    // Market Operations
    generateA2AEndpoint(A2A_METHODS.GET_MARKET_DATA, 0.15),
    generateA2AEndpoint(A2A_METHODS.SUBSCRIBE_MARKET, 0.1),

    // Portfolio
    generateA2AEndpoint(A2A_METHODS.GET_BALANCE, 0.15),
    generateA2AEndpoint(A2A_METHODS.GET_POSITIONS, 0.15),
    generateA2AEndpoint(A2A_METHODS.GET_USER_WALLET, 0.1),
  ],
};

/**
 * Stress test: Test rate limiting with rapid requests
 * This should trigger rate limit errors (429)
 */
export const A2A_RATE_LIMIT_STRESS: LoadTestConfig = {
  concurrentUsers: 10, // 10 agents
  durationSeconds: 120,
  rampUpSeconds: 5,
  thinkTimeMs: 0, // No think time - rapid fire
  maxRps: 200, // 200 RPS total = 20 RPS per agent (should hit 100/min limit)
  endpoints: [
    generateA2AEndpoint(A2A_METHODS.GET_BALANCE, 0.5),
    generateA2AEndpoint(A2A_METHODS.GET_POSITIONS, 0.5),
  ],
};

/**
 * All A2A test scenarios
 */
export const A2A_TEST_SCENARIOS = {
  LIGHT: A2A_LIGHT_SCENARIO,
  NORMAL: A2A_NORMAL_SCENARIO,
  HEAVY: A2A_HEAVY_SCENARIO,
  RATE_LIMIT: A2A_RATE_LIMIT_STRESS,
} as const;
