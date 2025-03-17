import type { CacheOptions, IAgentRuntime } from '@elizaos/core';
import BigNumber from 'bignumber.js';
import * as dotenv from 'dotenv';
import { BTC_ADDRESS, ETH_ADDRESS, SOL_ADDRESS } from './constants';
import type {
  DexScreenerData,
  DexScreenerPair,
  HolderData,
  Prices,
  TokenOverview,
  TokenSecurityData,
  TokenTradeData,
  WalletPortfolio,
  WalletPortfolioItem,
} from './types';
dotenv.config();

/**
 * Represents the next unique identifier for an RPC request.
 */
let nextRpcRequestId = 1;

/**
 * Represents the valid types that can be used for query parameters in a URL.
 * It can either be a key-value pair object with string, number, boolean, null or undefined values,
 * or an instance of the URLSearchParams class.
 */
type QueryParams = Record<string, string | number | boolean | null | undefined> | URLSearchParams;

/**
 * Interface representing retry options for a retry mechanism.
 * @typedef {Object} RetryOptions
 * @property {number} [maxRetries] - The maximum number of retries allowed.
 * @property {number} [initialDelay] - The initial delay in milliseconds before the first retry.
 * @property {number} [maxDelay] - The maximum delay in milliseconds between retries.
 * @property {number} [backoffFactor] - The factor by which the delay increases between retries.
 * @property {number[]} [retryableStatuses] - The array of HTTP status codes that are retryable.
 */
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  retryableStatuses?: number[];
}

/**
 * Interface for defining options that can be passed in a request.
 * @template RequestOptions
 * @property {RetryOptions} [retryOptions] - Options for retrying the request
 * @property {QueryParams} [params] - Query parameters for the request
 */
interface RequestOptions extends RequestInit {
  retryOptions?: RetryOptions;
  params?: QueryParams;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

/**
 * Represents an error that occurred during a request.
 * @extends Error
 * @param {string} message - The error message.
 * @param {Response} [response] - The response object associated with the error.
 */
class RequestError extends Error {
  /**
   *  Constructor for creating a RequestError instance.
   *
   * @param {string} message - The error message for the RequestError instance.
   * @param {Response} [response] - Optional response object associated with the error.
   */
  constructor(
    message: string,
    public response?: Response
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const calculateDelay = (attempt: number, options: Required<RetryOptions>): number => {
  const delay = options.initialDelay * options.backoffFactor ** (attempt - 1);
  return Math.min(delay, options.maxDelay);
};

const isRetryableError = (error: any): boolean =>
  error.name === 'TypeError' || error.name === 'AbortError' || error instanceof RequestError;

/**
 * Build a URL with optional query parameters.
 *
 * @param {string} url - The base URL.
 * @param {QueryParams} [params] - Optional query parameters to be appended to the URL.
 * @return {string} The URL with query parameters appended.
 */
const buildUrl = (url: string, params?: QueryParams): string => {
  if (!params) return url;

  const searchParams =
    params instanceof URLSearchParams
      ? params
      : new URLSearchParams(
          Object.entries(params)
            .filter(([_, value]) => value != null)
            .map(([key, value]) => [key, String(value)])
        );

  const separator = url.includes('?') ? '&' : '?';
  const queryString = searchParams.toString();

  return queryString ? `${url}${separator}${queryString}` : url;
};

/**
 * HTTP utility functions for making requests and handling responses.
 * @namespace http
 */
export const http = {
  async request(url: string, options?: RequestOptions): Promise<Response> {
    const { params, ...fetchOptions } = options || {};
    const fullUrl = buildUrl(url, params);

    const retryOptions: Required<RetryOptions> = {
      ...DEFAULT_RETRY_OPTIONS,
      ...options?.retryOptions,
    };

    let attempt = 1;

    while (true) {
      try {
        const res = await fetch(fullUrl, fetchOptions);

        if (!res.ok) {
          const errorText = await res.text();
          throw new RequestError(`Request failed with status ${res.status}: ${errorText}`, res);
        }

        return res;
      } catch (error: any) {
        if (isRetryableError(error) && attempt < retryOptions.maxRetries) {
          const delay = calculateDelay(attempt, retryOptions);
          console.warn(
            `Request failed with error: ${error.message}. ` +
              `Retrying in ${delay}ms (attempt ${attempt}/${retryOptions.maxRetries})`
          );
          await sleep(delay);
          attempt++;
          continue;
        }
        console.error(`Request failed after ${attempt} attempts:`, error);

        throw error;
      }
    }
  },

  async json<T = any>(url: string, options?: RequestOptions) {
    const res = await this.request(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    return (await res.json()) as T;
  },

  get: {
    async request(url: string, params?: QueryParams, options?: RequestInit) {
      return http.request(url, {
        ...options,
        method: 'GET',
        params,
      });
    },
    async json<T = any>(url: string, params?: QueryParams, options?: RequestInit) {
      return http.json<T>(url, {
        ...options,
        method: 'GET',
        params,
      });
    },
  },

  post: {
    async request(url: string, body: object, options?: RequestOptions) {
      return http.request(url, {
        ...options,
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async json<ReturnType = any, Body extends object = object>(
      url: string,
      body: Body,
      options?: RequestOptions
    ) {
      return http.json<ReturnType>(url, {
        ...options,
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  },

  async jsonrpc<_ReturnType = any, Params extends object = object>(
    url: string,
    method: string,
    params: Params,
    headers?: HeadersInit
  ) {
    return this.post.json(
      url,
      {
        jsonrpc: '2.0',
        id: nextRpcRequestId++,
        method,
        params,
      },
      { headers }
    );
  },

  async graphql<_ReturnType = any, Variables extends object = object>(
    url: string,
    query: string,
    variables: Variables,
    headers?: HeadersInit
  ) {
    return this.post.json(
      url,
      {
        query,
        variables,
      },
      { headers }
    );
  },
};

/**
 * Class representing a client for interacting with the Jupiter API for swapping tokens.
 */

export class JupiterClient {
  static baseUrl = 'https://api.jup.ag/swap/v1';
  static xApiKey = process.env.JUPITER_API_KEY || '';

  /**
   * Fetches a quote for a given input and output mint, amount, and slippage.
   * @param {string} inputMint The mint of the input token.
   * @param {string} outputMint The mint of the output token.
   * @param {string} amount The amount to be swapped.
   * @param {number} [slippageBps=50] The slippage tolerance in basis points (default: 50).
   * @returns {Promise<{inputMint: string, outputMint: string, inAmount: string, outAmount: string, routePlan: any[]} | {error: unknown}>} The quote object or an error object.
   */
  static async getQuote(inputMint: string, outputMint: string, amount: string, slippageBps = 50) {
    const headers: Record<string, string> = {};
    if (JupiterClient.xApiKey) {
      headers['x-api-key'] = JupiterClient.xApiKey;
    }

    const quote = await http.get.json<
      | {
          inputMint: string;
          outputMint: string;
          inAmount: string;
          outAmount: string;
          routePlan: any[];
        }
      | { error: unknown }
    >(
      `${JupiterClient.baseUrl}/quote`,
      {
        inputMint,
        outputMint,
        amount,
        slippageBps: slippageBps.toString(),
      },
      { headers }
    );

    if ('error' in quote) {
      console.error('Quote error:', quote);
      throw new Error(`Failed to get quote: ${quote?.error || 'Unknown error'}`);
    }

    return quote;
  }

  /**
   * Perform a swap operation using the provided quote data and user's wallet public key.
   * @param {any} quoteData - The data required for the swap operation.
   * @param {string} walletPublicKey - The public key of the user's wallet.
   * @returns {Promise<any>} The result of the swap operation.
   */
  static async swap(quoteData: any, walletPublicKey: string) {
    const headers: Record<string, string> = {};
    if (JupiterClient.xApiKey) {
      headers['x-api-key'] = JupiterClient.xApiKey;
    }

    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: walletPublicKey,
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 2000000,
      dynamicComputeUnitLimit: true,
    };

    const swapData = await http.post.json(`${JupiterClient.baseUrl}/swap`, swapRequestBody, {
      headers,
    });

    if (!swapData || !swapData.swapTransaction) {
      console.error('Swap error:', swapData);
      throw new Error(
        `Failed to get swap transaction: ${swapData?.error || 'No swap transaction returned'}`
      );
    }

    return swapData;
  }
}

/**
 * Options for Dexscreener.
 * @typedef {Object} DexscreenerOptions
 * @property {string|CacheOptions["expires"]} [expires] - The expiration time for the cache.
 */
type DexscreenerOptions = {
  expires?: string | CacheOptions['expires'];
};

/**
 * Client for interacting with DexScreener API.
 */

export class DexscreenerClient {
  /**
   * Constructor for the class.
   * @param {IAgentRuntime} runtime - The runtime passed as a parameter to the constructor.
   */
  constructor(private runtime: IAgentRuntime) {}

  /**
   * Create a new DexscreenerClient instance using the provided agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for creating the DexscreenerClient instance.
   * @returns {DexscreenerClient} A new instance of DexscreenerClient.
   */
  static createFromRuntime(runtime: IAgentRuntime) {
    return new DexscreenerClient(runtime);
  }

  /**
   * Makes an asynchronous HTTP request to the DexScreener API.
   *
   * @template T - The type of data expected to be returned
   * @param {string} path - The endpoint path for the API request
   * @param {QueryParams} [params] - Optional query parameters for the request
   * @param {DexscreenerOptions} [options] - Optional options for the request
   * @returns {Promise<T>} - A promise that resolves with the data returned from the API
   */
  async request<T = any>(path: string, params?: QueryParams, options?: DexscreenerOptions) {
    const cacheKey = [
      'dexscreener',
      buildUrl(path, params), // remove first "/"
    ]
      .filter(Boolean)
      .join('/');

    if (options?.expires) {
      const cached = await this.runtime.getCache<T>(cacheKey);
      if (cached) return cached;
    }

    const res = await http.get.json<T>(`https://api.dexscreener.com/${path}`, params);

    if (options?.expires) {
      await this.runtime.setCache<T>(cacheKey, res);
    }

    return res;
  }

  /**
   * Asynchronously searches for DexScreener data based on the provided address.
   *
   * @param {string} address - The address to search for in DexScreener data.
   * @param {DexscreenerOptions} [options] - Optional parameters for the request.
   * @returns {Promise<DexScreenerData>} A promise that resolves with the DexScreener data.
   */
  async search(address: string, options?: DexscreenerOptions): Promise<DexScreenerData> {
    try {
      const data = await this.request<DexScreenerData>(
        'latest/dex/search',
        {
          q: address,
        },
        options
      );

      if (!data || !data.pairs) {
        throw new Error('No DexScreener data available');
      }

      return data;
    } catch (error) {
      console.error('Error fetching DexScreener data:', error);
      return {
        schemaVersion: '1.0.0',
        pairs: [],
      };
    }
  }

  /**
   * Asynchronously searches for the pair with the highest liquidity based on the given address.
   *
   * @param {string} address The address to search for liquidity pairs from.
   * @param {string} [chain] The chain ID to filter the liquidity pairs by.
   * @param {DexscreenerOptions} [options] Additional options for searching.
   * @returns {Promise<DexScreenerPair | null>} The pair with the highest liquidity, or null if no pairs were found.
   */
  async searchForHighestLiquidityPair(
    address: string,
    chain?: string,
    options?: DexscreenerOptions
  ): Promise<DexScreenerPair | null> {
    let { pairs } = await this.search(address, options);

    if (pairs.length === 0) {
      return null;
    }

    if (chain) {
      pairs = pairs.filter((pair) => pair.chainId === chain);
    }

    // Sort pairs by both liquidity and market cap to get the highest one
    return pairs.sort((a, b) => {
      const liquidityA = a.liquidity?.usd ?? 0;
      const liquidityB = b.liquidity?.usd ?? 0;
      return liquidityB < liquidityA ? -1 : 1;
    })[0];
  }
}

/**
 * Represents a client for interacting with the Helius API.
 */
export class HeliusClient {
  private runtime: IAgentRuntime;

  /**
   * Constructor for initializing an instance of class.
   *
   * @param apiKey - The API key to be used for authentication.
   * @param _runtime - The runtime environment for the agent.
   */
  constructor(
    private readonly apiKey: string,
    _runtime: IAgentRuntime
  ) {}

  /**
   * Creates a new HeliusClient instance using the provided IAgentRuntime.
   *
   * @param {IAgentRuntime} runtime - The IAgentRuntime to use for creating the HeliusClient.
   * @returns {HeliusClient} A new instance of HeliusClient.
   * @throws {Error} Thrown if HELIUS_API_KEY is missing from the runtime settings.
   */
  static createFromRuntime(runtime: IAgentRuntime) {
    const apiKey = runtime.getSetting('HELIUS_API_KEY');

    if (!apiKey) {
      throw new Error('missing HELIUS_API_KEY');
    }

    return new HeliusClient(apiKey, runtime);
  }

  /**
   * Fetches the list of token holders for a given address asynchronously.
   * If the option `expires` is provided and there is a cached version available, it returns the cached data.
   * Otherwise, it fetches the data from the Helius API using the provided address.
   *
   * @param {string} address - The address for which to fetch the list of token holders.
   * @param {Object} [options] - Optional parameters.
   * @param {string | CacheOptions["expires"]} [options.expires] - The expiration date for caching the data.
   *
   * @returns {Promise<HolderData[]>} A promise that resolves to an array of HolderData objects representing the token holders.
   */
  async fetchHolderList(
    address: string,
    options?: { expires?: string | CacheOptions['expires'] }
  ): Promise<HolderData[]> {
    if (options?.expires) {
      const cached = await this.runtime.getCache<HolderData[]>(`helius/token-holders/${address}`);

      if (cached) return cached;
    }

    const allHoldersMap = new Map<string, number>();
    let page = 1;
    const limit = 1000;
    let cursor;
    //HELIOUS_API_KEY needs to be added
    const url = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;

    try {
      while (true) {
        const params = {
          limit: limit,
          displayOptions: {},
          mint: address,
          cursor: cursor,
        };

        if (cursor !== undefined) {
          params.cursor = cursor;
        }

        if (page > 2) {
          break;
        }

        const data = await http.jsonrpc(url, 'getTokenAccounts', params);

        if (
          !data ||
          !data.result ||
          !data.result.token_accounts ||
          data.result.token_accounts.length === 0
        ) {
          break;
        }

        data.result.token_accounts.forEach((account: any) => {
          const owner = account.owner;
          const balance = Number.parseFloat(account.amount);

          if (allHoldersMap.has(owner)) {
            allHoldersMap.set(owner, allHoldersMap.get(owner)! + balance);
          } else {
            allHoldersMap.set(owner, balance);
          }
        });
        cursor = data.result.cursor;
        page++;
      }

      const holders: HolderData[] = Array.from(allHoldersMap.entries()).map(
        ([address, balance]) => ({
          address,
          balance: balance.toString(),
        })
      );

      if (options?.expires)
        await this.runtime.setCache<HolderData[]>(`helius/token-holders/${address}`, holders);

      return holders;
    } catch (error) {
      console.error('Error fetching holder list from Helius:', error);
      throw new Error('Failed to fetch holder list from Helius.');
    }
  }
}

/**
 * Options for Coingecko API.
 * @typedef {Object} CoingeckoOptions
 * @property {string | CacheOptions["expires"]} [expires] - The expiration date for the cache.
 */
type CoingeckoOptions = {
  expires?: string | CacheOptions['expires'];
};

/**
 * CoingeckoClient class for interacting with the Coingecko API.
 * @constructor
 * @param { string } apiKey - The API key required for accessing the Coingecko API.
 * @param { IAgentRuntime } runtime - The IAgentRuntime object for accessing runtime settings.
 */
export class CoingeckoClient {
  /**
   * Constructor for initializing a new instance of the class.
   * @param apiKey The API key used for authentication.
   * @param runtime The agent runtime implementation.
   */
  constructor(
    private readonly apiKey: string,
    private readonly runtime: IAgentRuntime
  ) {}

  /**
   * Creates a new instance of CoingeckoClient using the apiKey retrieved from the provided runtime.
   * @param {IAgentRuntime} runtime - The runtime object that contains the COINGECKO_API_KEY setting.
   * @throws {Error} If COINGECKO_API_KEY setting is missing in the runtime object.
   * @returns {CoingeckoClient} A new instance of CoingeckoClient initialized with the apiKey and runtime.
   */
  static createFromRuntime(runtime: IAgentRuntime) {
    const apiKey = runtime.getSetting('COINGECKO_API_KEY');

    if (!apiKey) {
      throw new Error('missing COINGECKO_API_KEY');
    }

    return new CoingeckoClient(apiKey, runtime);
  }

  /**
   * Makes an asynchronous HTTP request to the Coingecko API.
   * @template T
   * @param {string} path - The API endpoint to call.
   * @param {QueryParams} [params] - Optional query parameters to include in the request.
   * @param {CoingeckoOptions} [options] - Additional options for the request.
   * @returns {Promise<T>} The response data from the API.
   */
  async request<T = any>(path: string, params?: QueryParams, options?: CoingeckoOptions) {
    const cacheKey = ['coingecko', buildUrl(path, params)].filter(Boolean).join('/');

    if (options?.expires) {
      const cached = await this.runtime.getCache<T>(cacheKey);
      if (cached) return cached;
    }

    const res = await http.get.json<T>(`https://api.coingecko.com/api/v3/${path}`, params, {
      headers: {
        'x-cg-demo-api-key': this.apiKey,
      },
    });

    if (options?.expires) {
      await this.runtime.setCache<T>(cacheKey, res);
    }

    return res;
  }

  /**
   * Fetches prices for specified cryptocurrencies from the Coingecko API.
   *
   * @param {CoingeckoOptions} [options] The options for the Coingecko API request.
   * @returns {Promise<Prices>} A Promise that resolves to the prices of the specified cryptocurrencies.
   */
  async fetchPrices(options?: CoingeckoOptions): Promise<Prices> {
    const prices = await this.request<Prices>(
      'simple/price',
      {
        ids: 'solana,bitcoin,ethereum',
        vs_currencies: 'usd',
      },
      options
    );

    return prices;
  }

  /**
   * Asynchronously fetches global data.
   *
   * @returns {Promise} The promise containing the global data.
   */
  async fetchGlobal() {
    return this.request(
      'global',
      {},
      {
        expires: '30m',
      }
    );
  }

  /**
   * Asynchronously fetches a list of coin categories.
   * @returns {Promise} The Promise object representing the result of the fetch operation.
   */
  async fetchCategories() {
    return this.request(
      'coins/categories',
      {},
      {
        expires: '30m',
      }
    );
  }
}

/**
 * Represents an item in a wallet token list with details such as address, name, symbol, decimals, balance, UI amount, chain ID, logo URI, price in USD, and value in USD.
 * @typedef {Object} WalletTokenListItem
 * @property {string} address - The address of the token
 * @property {string} name - The name of the token
 * @property {string} symbol - The symbol of the token
 * @property {number} decimals - The decimals of the token
 * @property {number} balance - The balance of the token
 * @property {number} uiAmount - The UI amount of the token
 * @property {string} chainId - The chain ID of the token
 * @property {string} logoURI - The logo URI of the token
 * @property {number} priceUsd - The price of the token in USD
 * @property {number} valueUsd - The value of the token in USD
 */
type WalletTokenListItem = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: number;
  uiAmount: number;
  chainId: string;
  logoURI: string;
  priceUsd: number;
  valueUsd: number;
};

/**
 * Defines the structure of a WalletTokenList object, which includes the wallet name, total USD balance,
 * and an array of WalletTokenListItem objects.
 */
type WalletTokenList = {
  wallet: string;
  totalUsd: number;
  items: WalletTokenListItem[];
};

/**
 * Represents a type that can either be "solana" or "ethereum" for the BirdeyeXChain.
 */
type BirdeyeXChain = 'solana' | 'ethereum';

/**
 * Type representing headers for BirdeyeClient.
 * @typedef {Object} BirdeyeClientHeaders
 * @property {BirdeyeXChain} ["x-chain"] - Optional header for BirdeyeXChain.
 */
type BirdeyeClientHeaders = {
  'x-chain'?: BirdeyeXChain;
};

/**
 * Options for making a Birdeye API request.
 * @typedef {Object} BirdeyeRequestOptions
 * @property {BirdeyeXChain} [chain] - The BirdeyeX chain.
 * @property {string | CacheOptions["expires"]} [expires] - The expiration date for the request.
 */

type BirdeyeRequestOptions = {
  chain?: BirdeyeXChain;
  expires?: string | CacheOptions['expires'];
};

/**
 * Class representing a client for interacting with the BirdEye API.
 */

export class BirdeyeClient {
  static readonly url = 'https://public-api.birdeye.so/';

  /**
   * Send a request to the Birdeye API using the provided API key, path, query parameters, and headers.
   *
   * @param {string} apiKey - The API key for authenticating the request.
   * @param {string} path - The endpoint path to send the request to.
   * @param {QueryParams} [params] - Optional query parameters to include in the request.
   * @param {BirdeyeClientHeaders} [headers] - Optional additional headers to include in the request.
   * @returns {Promise<T>} A Promise that resolves with the data received from the API request.
   */
  static async request<T = any>(
    apiKey: string,
    path: string,
    params?: QueryParams,
    headers?: BirdeyeClientHeaders
  ): Promise<T> {
    const res = await http.get.json<{ success: boolean; data?: T }>(
      BirdeyeClient.url + path,
      params,
      {
        headers: {
          ...headers,
          'X-API-KEY': apiKey,
        },
      }
    );

    if (!res.success || !res.data) {
      console.error({ res });
      throw new Error(`Birdeye request failed:${path}`);
    }

    return res.data;
  }

  /**
   * Constructor for initializing a new instance.
   *
   * @param apiKey The API key to be used.
   * @param runtime The agent runtime for handling communication with the runtime environment.
   */
  constructor(
    private readonly apiKey: string,
    private readonly runtime: IAgentRuntime
  ) {}

  /**
   * Create a new BirdeyeClient instance using the provided IAgentRuntime object.
   *
   * @param {IAgentRuntime} runtime - The IAgentRuntime object that provides access to runtime settings.
   * @returns {BirdeyeClient} A new instance of BirdeyeClient initialized with the provided API key and runtime.
   * @throws {Error} Thrown if the BIRDEYE_API_KEY setting is missing in the runtime object.
   */
  static createFromRuntime(runtime: IAgentRuntime) {
    const apiKey = runtime.getSetting('BIRDEYE_API_KEY');

    if (!apiKey) {
      throw new Error('missing BIRDEYE_API_KEY');
    }

    return new BirdeyeClient(apiKey, runtime);
  }

  /**
   * Performs a request to the specified path with given query parameters and options.
   * @template T
   * @param {string} path - The path to request.
   * @param {QueryParams} params - The query parameters to include in the request.
   * @param {BirdeyeRequestOptions} [options] - Optional request options.
   * @param {boolean} [forceRefresh] - Flag to force refresh the cache.
   * @returns {Promise<T>} The response data from the request.
   */
  async request<T = any>(
    path: string,
    params: QueryParams,
    options?: BirdeyeRequestOptions,
    forceRefresh?: boolean
  ) {
    const cacheKey = ['birdeye', options?.chain, buildUrl(path, params)].filter(Boolean).join('/');

    if (options?.expires && !forceRefresh) {
      const cached = await this.runtime.getCache<T>(cacheKey);
      if (cached) return cached;
    }

    const response = await BirdeyeClient.request<T>(
      this.apiKey,
      path,
      params,
      options?.chain
        ? {
            'x-chain': options.chain,
          }
        : undefined
    );

    if (options?.expires) {
      await this.runtime.setCache<T>(cacheKey, response);
    }

    return response;
  }

  /**
   * Fetches the price for a given address.
   *
   * @param {string} address - The address for which to fetch the price.
   * @param {BirdeyeRequestOptions} [options] - The options for the Birdeye request.
   * @returns {Promise<number>} The price value fetched for the given address.
   */
  async fetchPrice(address: string, options?: BirdeyeRequestOptions): Promise<number> {
    const price = await this.request<{ value: number }>('defi/price', { address }, options);

    return price.value;
  }

  /**
   * Fetches the latest prices for Bitcoin, Ethereum, and Solana in USD from the DeFi API.
   * @returns {Promise<Prices>} The latest prices for Bitcoin, Ethereum, and Solana in USD.
   */
  async fetchPrices(): Promise<Prices> {
    const prices = await this.request<Record<string, { value: number }>>(
      'defi/multi_price',
      { list_address: [SOL_ADDRESS, ETH_ADDRESS, BTC_ADDRESS].join(',') },
      {
        chain: 'solana',
        expires: '5m',
      }
    );

    return {
      bitcoin: { usd: prices[BTC_ADDRESS].value.toString() },
      ethereum: { usd: prices[ETH_ADDRESS].value.toString() },
      solana: { usd: prices[SOL_ADDRESS].value.toString() },
    };
  }

  /**
   * Fetches token overview for a specific address.
   *
   * @param {string} address The address of the token for which overview is to be fetched.
   * @param {BirdeyeRequestOptions} [options] Additional options for the Birdeye request.
   * @param {boolean} [forceRefresh=false] Flag to force refresh the data.
   * @returns {Promise<TokenOverview>} Promise that resolves to the token overview.
   */
  async fetchTokenOverview(
    address: string,
    options?: BirdeyeRequestOptions,
    forceRefresh = false
  ): Promise<TokenOverview> {
    const token = await this.request<TokenOverview>(
      'defi/token_overview',
      { address },
      options,
      forceRefresh
    );

    return token;
  }

  /**
   * Fetches token security data from the API for a given address.
   * @param {string} address - The address of the token for which to fetch security data.
   * @param {BirdeyeRequestOptions} [options] - Optional request options.
   * @returns {Promise<TokenSecurityData>} A promise that resolves with the token security data.
   */
  async fetchTokenSecurity(
    address: string,
    options?: BirdeyeRequestOptions
  ): Promise<TokenSecurityData> {
    const security = await this.request<TokenSecurityData>(
      'defi/token_security',
      { address },
      options
    );

    return security;
  }

  /**
   * Fetches token trade data for a specific address.
   * @param {string} address - The address of the token.
   * @param {BirdeyeRequestOptions} [options] - Optional request options.
   * @returns {Promise<TokenTradeData>} - A promise that resolves with the token trade data.
   */
  async fetchTokenTradeData(
    address: string,
    options?: BirdeyeRequestOptions
  ): Promise<TokenTradeData> {
    const tradeData = await this.request<TokenTradeData>(
      'defi/v3/token/trade-data/single',
      { address },
      options
    );

    return tradeData;
  }

  /**
   * Fetches the wallet token list for a given address.
   *
   * @param {string} address - The address of the wallet to fetch the token list for.
   * @param {BirdeyeRequestOptions} [options] - Additional options for the request.
   * @returns {Promise<WalletTokenList>} The wallet token list for the specified address.
   */
  async fetchWalletTokenList(address: string, options?: BirdeyeRequestOptions) {
    const tokenList = await this.request<WalletTokenList>(
      'v1/wallet/token_list',
      { wallet: address },
      options
    );

    return tokenList;
  }

  /**
   * Asynchronously fetches the portfolio value for a given address.
   *
   * @param {string} address - The address for which to fetch the portfolio value.
   * @param {BirdeyeRequestOptions} [options] - The optional request options.
   * @returns {Promise<WalletPortfolio>} - A promise that resolves to the wallet portfolio object containing total USD, total SOL, and portfolio items.
   * @throws {Error} - If an error occurs while fetching the portfolio value.
   */
  async fetchPortfolioValue(
    address: string,
    options?: BirdeyeRequestOptions
  ): Promise<WalletPortfolio> {
    try {
      const portfolio: WalletPortfolio = {
        totalUsd: '0',
        totalSol: '0',
        items: [],
      };

      const tokenList = await this.fetchWalletTokenList(address, options);

      const totalUsd = new BigNumber(tokenList.totalUsd.toString());

      const solPriceInUSD = new BigNumber(await this.fetchPrice(SOL_ADDRESS));

      const items: WalletPortfolioItem[] = tokenList.items.map((item) => ({
        address: item.address,
        name: item.name || 'Unknown',
        symbol: item.symbol || 'Unknown',
        decimals: item.decimals,
        valueSol: new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6),
        priceUsd: item.priceUsd?.toString() || '0',
        valueUsd: item.valueUsd?.toString() || '0',
        uiAmount: item.uiAmount?.toString() || '0',
        balance: item.balance?.toString() || '0',
      }));

      const totalSol = totalUsd.div(solPriceInUSD);
      portfolio.totalUsd = totalUsd.toString();
      portfolio.totalSol = totalSol.toFixed(6);
      portfolio.items = items.sort((a, b) =>
        new BigNumber(b.valueUsd).minus(new BigNumber(a.valueUsd)).toNumber()
      );

      return portfolio;
    } catch (error) {
      console.error('Error fetching portfolio:', error);
      throw error;
    }
  }
}

const units = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parses a time string to milliseconds.
 * @param {string} timeStr - The time string to parse (e.g. '5ms', '10s').
 * @returns {number} The time string parsed to milliseconds, or 0 if the string cannot be parsed.
 */
function parseTimeToMs(timeStr: string) {
  const match = timeStr.match(/^(\d+)([a-z]+)$/i);
  if (!match) return 0;

  const [_, value, unit] = match;
  return units[unit.toLowerCase()] * Number.parseInt(value);
}

/**
 * Parses the expiration time to milliseconds.
 *
 * @param {string | number} expires - The expiration time to be parsed.
 * @returns {number} The expiration time in milliseconds.
 */
function parseExpires(expires: string | number) {
  return typeof expires === 'string' ? parseTimeToMs(expires) : expires;
}
