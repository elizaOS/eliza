/**
 * Configuration object for the provider API endpoints and settings.
 * @type {object}
 * @property {string} BIRDEYE_API - The base URL for the Birdeye API.
 * @property {string} TOKEN_SECURITY_ENDPOINT - The endpoint for token security information.
 * @property {string} TOKEN_METADATA_ENDPOINT - The endpoint for token metadata.
 * @property {string} MARKET_SEARCH_ENDPOINT - The endpoint for token market search data.
 * @property {string} TOKEN_PRICE_CHANGE_ENDPOINT - The endpoint for token price change data.
 * @property {string} TOKEN_VOLUME_24_CHANGE_ENDPOINT - The endpoint for token volume change data.
 * @property {string} TOKEN_BUY_24_CHANGE_ENDPOINT - The endpoint for token buy change data.
 * @property {string} TOKEN_SECURITY_ENDPOINT_BASE - The base endpoint for token security information.
 * @property {string} TOKEN_METADATA_ENDPOINT_BASE - The base endpoint for token metadata.
 * @property {string} MARKET_SEARCH_ENDPOINT_BASE - The base endpoint for token market search data.
 * @property {string} TOKEN_PRICE_CHANGE_ENDPOINT_BASE - The base endpoint for token price change data.
 * @property {string} TOKEN_VOLUME_24_ENDPOINT_BASE - The base endpoint for token volume data.
 * @property {string} TOKEN_BUY_24_ENDPOINT_BASE - The base endpoint for token buy data.
 * @property {number} MAX_RETRIES - The maximum number of retries for API requests.
 * @property {number} RETRY_DELAY - The delay time (in milliseconds) for retrying API requests.
 */
export const PROVIDER_CONFIG = {
  BIRDEYE_API: 'https://public-api.birdeye.so',
  TOKEN_SECURITY_ENDPOINT: '/defi/token_security?address=',
  TOKEN_METADATA_ENDPOINT: '/defi/v3/token/meta-data/single?address=',
  MARKET_SEARCH_ENDPOINT: '/defi/v3/token/trade-data/single?address=',
  TOKEN_PRICE_CHANGE_ENDPOINT:
    '/defi/v3/search?chain=solana&target=token&sort_by=price_change_24h_percent&sort_type=desc&verify_token=true&markets=Raydium&limit=20',
  TOKEN_VOLUME_24_CHANGE_ENDPOINT:
    '/defi/v3/search?chain=solana&target=token&sort_by=volume_24h_change_percent&sort_type=desc&verify_token=true&markets=Raydium&limit=20',
  TOKEN_BUY_24_CHANGE_ENDPOINT:
    '/defi/v3/search?chain=solana&target=token&sort_by=buy_24h_change_percent&sort_type=desc&verify_token=true&markets=Raydium&offset=0&limit=20',

  TOKEN_SECURITY_ENDPOINT_BASE: '/defi/token_security?address=',
  TOKEN_METADATA_ENDPOINT_BASE: '/defi/v3/token/meta-data/single?address=',
  MARKET_SEARCH_ENDPOINT_BASE: '/defi/v3/token/trade-data/single?address=',
  TOKEN_PRICE_CHANGE_ENDPOINT_BASE:
    '/defi/v3/search?chain=base&target=token&sort_by=price_change_24h_percent&sort_type=desc&offset=0&limit=20',
  TOKEN_VOLUME_24_ENDPOINT_BASE:
    '/defi/v3/search?chain=base&target=token&sort_by=volume_24h_usd&sort_type=desc&offset=2&limit=20',
  TOKEN_BUY_24_ENDPOINT_BASE:
    '/defi/v3/search?chain=base&target=token&sort_by=buy_24h&sort_type=desc&offset=2&limit=20',

  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
};

// Add configuration for enabled chains
export const CHAIN_CONFIG = {
  SOLANA_ENABLED: false, // Can be controlled via settings
  BASE_ENABLED: true, // Can be controlled via settings
};

// Add Base chain configuration near other export constants
/**
 * Base configuration object that contains various constants related to the application setup.
 * @type {Object}
 * @property {string} RPC_URL - The URL for the RPC provider, defaults to mainnet.base.org if not provided.
 * @property {string} ROUTER_ADDRESS - The address for the Base Uniswap V2 Router.
 * @property {string} WETH_ADDRESS - The address for the Base WETH token.
 * @property {number} CHAIN_ID - The chain ID for the network.
 * @property {Object} AERODROME - Object containing Aerodrome-specific addresses.
 * @property {string} AERODROME.WETH - The WETH address for Aerodrome.
 * @property {string} AERODROME.USDC - The USDC address for Aerodrome.
 * @property {string} AERODROME.USDT - The USDT address for Aerodrome.
 */
export const BASE_CONFIG = {
  RPC_URL: process.env.EVM_PROVIDER_URL || 'https://mainnet.base.org',
  ROUTER_ADDRESS: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // Base Uniswap V2 Router
  WETH_ADDRESS: '0x4200000000000000000000000000000000000006', // Base WETH
  CHAIN_ID: 8453,
  // Add Aerodrome-specific addresses
  AERODROME: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  },
};

// Add 0x API configuration near other export constants
/**
 * Configuration object for interacting with the 0x API.
 * @constant
 * @type {Object}
 * @property {string} API_URL - The base URL for the 0x API.
 * @property {string} API_KEY - The API key used for authentication.
 * @property {string} QUOTE_ENDPOINT - The endpoint for obtaining quotes.
 * @property {string} PRICE_ENDPOINT - The endpoint for obtaining prices.
 * @property {Object} SUPPORTED_CHAINS - Object containing supported chain IDs.
 * @property {number} SUPPORTED_CHAINS.BASE - The base chain ID.
 * @property {Object} HEADERS - Object containing custom HTTP headers.
 * @property {string} HEADERS.Content-Type - The Content-Type header value.
 * @property {string} HEADERS.0x-api-key - The 0x API key header value.
 * @property {string} HEADERS.0x-version - The 0x API version header value.
 */
export const ZEROEX_CONFIG = {
  API_URL: 'https://api.0x.org',
  API_KEY: process.env.ZEROEX_API_KEY || '',
  QUOTE_ENDPOINT: '/swap/permit2/quote',
  PRICE_ENDPOINT: '/swap/permit2/price',
  SUPPORTED_CHAINS: {
    BASE: 8453,
  },
  HEADERS: {
    'Content-Type': 'application/json',
    '0x-api-key': process.env.ZEROEX_API_KEY || '',
    '0x-version': 'v2',
  },
};

// Add required settings configuration
export const REQUIRED_SETTINGS = {
  SOLANA_PUBLIC_KEY: 'Public key of the trading wallet',
};

export const SAFETY_LIMITS = {
  MINIMUM_TRADE: 0.1,
  MAX_SLIPPAGE: 0.05,
  MIN_LIQUIDITY: 50000,
  MIN_VOLUME: 10000,
  MAX_PRICE_CHANGE: 30,
};
