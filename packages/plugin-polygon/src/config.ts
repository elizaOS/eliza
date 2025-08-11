/**
 * Configuration constants for the Polygon plugin
 * Contains network RPC URLs, contract addresses, and other fixed configuration values
 */

// RPC URLs for Ethereum (L1) and Polygon (L2)
// Using Infura endpoints as defaults
export const DEFAULT_RPC_URLS = {
  ETHEREUM_RPC_URL: "https://mainnet.infura.io/v3/acc75dee85124d4db03ba3b3a9a9e3ab",
  POLYGON_RPC_URL: "https://polygon-mainnet.infura.io/v3/acc75dee85124d4db03ba3b3a9a9e3ab"
};

// Contract addresses
export const CONTRACT_ADDRESSES = {
  // Ethereum (L1) contracts
  STAKE_MANAGER_ADDRESS_L1: '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908',
  ROOT_CHAIN_MANAGER_ADDRESS_L1: '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77',
  GOVERNANCE_TOKEN_ADDRESS_L1: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',
  TIMELOCK_ADDRESS_L1: '0x6e7a5FAFcec6BB1e78bAE2A1F0B612012BF14827',
  GOVERNOR_ADDRESS_L1: '0xD952175d6A20187d7A5803DcC9741472F640A9b8',
  
  // Polygon (L2) contracts
  GOVERNANCE_TOKEN_ADDRESS_L2: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  
  // Add other contract addresses as needed
};

// Default cache expiry times (milliseconds)
export const CACHE_EXPIRY = {
  BLOCK_NUMBER: 12000, // 12 seconds
  BALANCE: 30000,      // 30 seconds
  TRANSACTION: 0,      // Never expires (immutable)
  BLOCK: 60000,        // 1 minute
  TOKEN_METADATA: 3600000, // 1 hour
  DEFAULT: 60000       // Default 1 minute
};

// Gas price settings
export const GAS_SETTINGS = {
  DEFAULT_GAS_LIMIT: 21000,
  DEFAULT_GAS_MULTIPLIER: 1.1,
  MAX_GAS_PRICE_GWEI: 300,
  DEFAULT_PRIORITY_FEE_GWEI: 1.5
};

// API endpoints
export const API_ENDPOINTS = {
  ETHERSCAN_API: 'https://api.etherscan.io/api',
  POLYGONSCAN_API: 'https://api.polygonscan.com/api',
  GAS_STATION_API: 'https://gasstation-mainnet.matic.network/v2'
};

// Timeouts in milliseconds
export const TIMEOUTS = {
  TRANSACTION_WAIT: 300000, // 5 minutes
  RPC_REQUEST: 30000,       // 30 seconds
  APPROVAL: 120000          // 2 minutes
}; 