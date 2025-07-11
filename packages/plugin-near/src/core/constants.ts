import BigNumber from 'bignumber.js';
import { utils } from 'near-api-js';

// Network configurations
export const NEAR_NETWORKS = {
  mainnet: {
    networkId: 'mainnet',
    nodeUrl: 'https://near.lava.build',
    walletUrl: 'https://wallet.near.org',
    helperUrl: 'https://helper.mainnet.near.org',
    explorerUrl: 'https://explorer.near.org',
  },
  testnet: {
    networkId: 'testnet',
    nodeUrl: 'https://neart.lava.build',
    walletUrl: 'https://wallet.testnet.near.org',
    helperUrl: 'https://helper.testnet.near.org',
    explorerUrl: 'https://explorer.testnet.near.org',
  },
} as const;

// Contract addresses
export const CONTRACTS = {
  mainnet: {
    WRAP_NEAR: 'wrap.near',
    REF_FINANCE: 'v2.ref-finance.near',
    REF_TOKEN: 'token.v2.ref-finance.near',
    REF_DCL_SWAP: 'dclv2.ref-labs.near',
    AURORA_ENGINE: 'aurora',
    RAINBOW_BRIDGE: 'factory.bridge.near',
  },
  testnet: {
    WRAP_NEAR: 'wrap.testnet',
    REF_FINANCE: 'ref-finance-101.testnet',
    REF_TOKEN: 'ref.fakes.testnet',
    REF_DCL_SWAP: 'dclv2.ref-dev.testnet',
    AURORA_ENGINE: 'aurora.testnet',
    RAINBOW_BRIDGE: 'factory.testnet',
  },
} as const;

// Gas limits
export const GAS_LIMITS = {
  TRANSFER: '30000000000000', // 30 TGas
  FT_TRANSFER: '50000000000000', // 50 TGas
  SWAP: '300000000000000', // 300 TGas
  STAKE: '50000000000000', // 50 TGas
  UNSTAKE: '50000000000000', // 50 TGas
  ADD_LIQUIDITY: '100000000000000', // 100 TGas
  REMOVE_LIQUIDITY: '100000000000000', // 100 TGas
  STORAGE_DEPOSIT: '30000000000000', // 30 TGas
} as const;

// Storage deposits
export const STORAGE_AMOUNTS = {
  FT_MINIMUM: '0.00125', // 0.00125 NEAR
  FT_MINIMUM_LARGE: '0.0125', // 0.0125 NEAR
  REF_FINANCE: '0.1', // 0.1 NEAR
} as const;

// Export individual constants for compatibility
export const FT_MINIMUM_STORAGE_BALANCE =
  utils.format.parseNearAmount(STORAGE_AMOUNTS.FT_MINIMUM) || '0';
export const FT_MINIMUM_STORAGE_BALANCE_LARGE =
  utils.format.parseNearAmount(STORAGE_AMOUNTS.FT_MINIMUM_LARGE) || '0';
export const ONE_YOCTO_NEAR = '1';

// Numeric constants
export const NEAR_DECIMALS = 24;
export const ONE_NEAR = new BigNumber(10).pow(NEAR_DECIMALS);
export const ONE_YOCTO = '1';
export const MIN_ACCOUNT_BALANCE = '0.1'; // Minimum to keep account active

// Time constants
export const UNSTAKE_DELAY = 4 * 60 * 60 * 1000; // 4 epochs (~2 days)
export const CACHE_TTL = {
  BALANCE: 30 * 1000, // 30 seconds
  PRICE: 10 * 1000, // 10 seconds
  POOL: 60 * 1000, // 1 minute
  VALIDATOR: 5 * 60 * 1000, // 5 minutes
  TRANSACTION: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// API endpoints
export const API_ENDPOINTS = {
  COINGECKO: 'https://api.coingecko.com/api/v3',
  REF_INDEXER: {
    mainnet: 'https://indexer.ref.finance',
    testnet: 'https://testnet-indexer.ref-finance.com',
  },
  NEAR_BLOCKS: {
    mainnet: 'https://api.nearblocks.io/v1',
    testnet: 'https://api-testnet.nearblocks.io/v1',
  },
} as const;

// Default values
export const DEFAULTS = {
  SLIPPAGE: 0.01, // 1%
  MAX_SLIPPAGE: 0.1, // 10%
  PAGE_SIZE: 20,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second
} as const;

// Token lists
export const COMMON_TOKENS = {
  mainnet: [
    { id: 'wrap.near', symbol: 'wNEAR', decimals: 24 },
    {
      id: 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
      symbol: 'USDT',
      decimals: 6,
    },
    {
      id: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
      symbol: 'USDC',
      decimals: 6,
    },
    {
      id: '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
      symbol: 'DAI',
      decimals: 18,
    },
    { id: 'token.v2.ref-finance.near', symbol: 'REF', decimals: 18 },
    { id: 'aurora', symbol: 'AURORA', decimals: 18 },
  ],
  testnet: [
    { id: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 },
    { id: 'usdt.fakes.testnet', symbol: 'USDT', decimals: 6 },
    { id: 'usdc.fakes.testnet', symbol: 'USDC', decimals: 6 },
    { id: 'dai.fakes.testnet', symbol: 'DAI', decimals: 18 },
    { id: 'ref.fakes.testnet', symbol: 'REF', decimals: 18 },
    { id: 'aurora.fakes.testnet', symbol: 'AURORA', decimals: 18 },
  ],
} as const;

// Regex patterns
export const PATTERNS = {
  ACCOUNT_ID: /^[a-z0-9_-]+\.near$/,
  TESTNET_ACCOUNT_ID: /^[a-z0-9_-]+\.testnet$/,
  AMOUNT: /^\d+(\.\d+)?$/,
  TOKEN_ID: /^[a-zA-Z0-9._-]+$/,
  TRANSACTION_HASH: /^[A-Za-z0-9]+$/,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  INVALID_ACCOUNT: 'Invalid NEAR account ID format',
  INVALID_AMOUNT: 'Invalid amount format',
  INVALID_TOKEN: 'Invalid token ID',
  INSUFFICIENT_BALANCE: 'Insufficient balance for this operation',
  NO_STORAGE_DEPOSIT: 'Account needs storage deposit for this token',
  SLIPPAGE_TOO_HIGH: 'Slippage tolerance is too high',
  NETWORK_ERROR: 'Network error occurred, please try again',
} as const;
