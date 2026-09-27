/**
 * Automaton paid routes exposed as ElizaOS actions. Prices are informational: the 402 challenge
 * returned at call time is authoritative. /v2/sentinel/stream (SSE) is not an action.
 */
export const DEFAULT_BASE_URL = 'https://api.automaton-sovereign.workers.dev';
export const NETWORK = 'eip155:8453';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const AUTOMATON_PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

export type RouteId = 'scan' | 'sentinel-latest' | 'approval-risk' | 'simulate' | 'liquidity-risk';

export interface RouteDef {
  method: 'GET' | 'POST';
  path: string;
  priceUsd: number;
  description: string;
}

export const ROUTES: Record<RouteId, RouteDef> = {
  scan: {
    method: 'GET', path: '/v2/security/scan', priceUsd: 0.001,
    description: 'Bytecode security scan of a Base token contract: honeypot opcodes, mint/blacklist/pause/tax capabilities, risk score and verdict.'
  },
  'sentinel-latest': {
    method: 'GET', path: '/v2/sentinel/latest', priceUsd: 0.001,
    description: 'Newest liquidity pools created on Base (Uniswap v3/v4, Aerodrome) with a bytecode risk score for each new token.'
  },
  'approval-risk': {
    method: 'POST', path: '/v2/token/approval-risk', priceUsd: 0.01,
    description: 'Read-only audit of the ERC-20 approvals an owner granted for a token: spender, allowance, contract/EOA, verified, drainable amount, drain-risk verdict.'
  },
  simulate: {
    method: 'POST', path: '/v2/token/simulate', priceUsd: 0.01,
    description: 'Read-only buy/sell simulation of a Base token through the Uniswap V2 WETH pool: reverts, measured transfer tax, honeypot verdict. No transaction is sent.'
  },
  'liquidity-risk': {
    method: 'POST', path: '/v2/token/liquidity-risk', priceUsd: 0.01,
    description: 'One-block liquidity audit: Uniswap V3 / Aerodrome pools, USD needed to move the price 1/2/5/10%, concentration, LP burn evidence, explicit coverage gaps.'
  }
};
