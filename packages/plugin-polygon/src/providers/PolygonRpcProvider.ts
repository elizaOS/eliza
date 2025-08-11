import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type PrivateKeyAccount,
  type Chain,
  type Address,
  type HttpTransport,
  type Account,
  type Hash,
  type Transport,
  formatEther,
  toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as viemChains from 'viem/chains';
import { elizaLogger, type IAgentRuntime } from '@elizaos/core';

import { type NetworkType, type SupportedChain, type BlockIdentifier } from '../types.js';
import { DEFAULT_RPC_URLS, CACHE_EXPIRY } from '../config.js';
import { ERC20_ABI } from '../constants/abis.js';

/**
 * Provider for managing RPC clients for both Ethereum (L1) and Polygon (L2) networks.
 * Handles client initialization, chain configuration, and provides access to
 * appropriate clients based on the requested network.
 */
export class PolygonRpcProvider {
  // Chain configurations
  private l1Chain: Chain;
  private l2Chain: Chain;

  // Public clients (for read operations)
  private l1PublicClient: PublicClient;
  private l2PublicClient: PublicClient;

  // Wallet clients (for write operations)
  private l1WalletClient: WalletClient;
  private l2WalletClient: WalletClient;

  // Account info
  private account: PrivateKeyAccount;

  // Cache for response data with expiry times
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private defaultCacheExpiry = CACHE_EXPIRY.DEFAULT; // Use centralized cache expiry settings

  /**
   * Creates a new PolygonRpcProvider with connections to both L1 and L2 networks.
   */
  constructor(
    l1RpcUrl: string,
    l2RpcUrl: string,
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`
  ) {
    // Set up account
    this.account = typeof accountOrPrivateKey === 'string'
      ? privateKeyToAccount(accountOrPrivateKey)
      : accountOrPrivateKey;

    // Configure chains
    this.l1Chain = this.configureChain('mainnet', l1RpcUrl);
    this.l2Chain = this.configureChain('polygon', l2RpcUrl);

    // Initialize L1 clients (Ethereum)
    this.l1PublicClient = createPublicClient({
      chain: this.l1Chain,
      transport: http(l1RpcUrl)
    }) as PublicClient;
    
    this.l1WalletClient = createWalletClient({
      chain: this.l1Chain,
      transport: http(l1RpcUrl),
      account: this.account
    }) as WalletClient;
    
    // Initialize L2 clients (Polygon)
    this.l2PublicClient = createPublicClient({
      chain: this.l2Chain,
      transport: http(l2RpcUrl)
    }) as PublicClient;
    
    this.l2WalletClient = createWalletClient({
      chain: this.l2Chain,
      transport: http(l2RpcUrl),
      account: this.account
    }) as WalletClient;

    elizaLogger.log('PolygonRpcProvider initialized for both L1 and L2 networks');
  }
  
  /**
   * Gets the account address
   */
  getAddress(): Address {
    return this.account.address;
  }

  /**
   * Gets the appropriate public client based on the network
   */
  getPublicClient(network: NetworkType = 'L2'): PublicClient {
    return network === 'L1' ? this.l1PublicClient : this.l2PublicClient;
  }
  
  /**
   * Gets the appropriate wallet client based on the network
   */
  getWalletClient(network: NetworkType = 'L2'): WalletClient {
    return network === 'L1' ? this.l1WalletClient : this.l2WalletClient;
  }

  /**
   * Gets the chain configuration for the specified network
   */
  getChainConfig(network: NetworkType = 'L2'): Chain {
    return network === 'L1' ? this.l1Chain : this.l2Chain;
  }
  
  /**
   * Helper method to configure a chain with a custom RPC URL
   */
  private configureChain(chainName: SupportedChain, rpcUrl: string): Chain {
    const baseChain = viemChains[chainName];
    
    if (!baseChain?.id) {
      throw new Error(`Invalid chain name: ${chainName}`);
    }
    
    return {
      ...baseChain,
      rpcUrls: {
        ...baseChain.rpcUrls,
        default: {
          http: [rpcUrl]
        }
      }
    };
  }

  /**
   * Gets the current block number for the specified network
   */
  async getBlockNumber(network: NetworkType = 'L2'): Promise<number> {
    const cacheKey = `blockNumber:${network}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.BLOCK_NUMBER); // Use centralized cache expiry
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    const blockNumber = await client.getBlockNumber();
    
    this.setCache(cacheKey, Number(blockNumber));
    return Number(blockNumber);
  }

  /**
   * Gets a block by number or hash from the specified network
   */
  async getBlock(blockIdentifier: BlockIdentifier, network: NetworkType = 'L2'): Promise<any> {
    const cacheKey = `block:${network}:${blockIdentifier}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.BLOCK);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    let block;
    
    if (typeof blockIdentifier === 'number') {
      block = await client.getBlock({ blockNumber: BigInt(blockIdentifier) });
    } else {
      block = await client.getBlock({ blockHash: blockIdentifier });
    }
    
    this.setCache(cacheKey, block);
    return block;
  }

  /**
   * Gets transaction details by hash from the specified network
   */
  async getTransaction(hash: Hash, network: NetworkType = 'L2'): Promise<any> {
    const cacheKey = `tx:${network}:${hash}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.TRANSACTION);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    try {
      const tx = await client.getTransaction({ hash });
      this.setCache(cacheKey, tx);
      return tx;
    } catch (error) {
      elizaLogger.error(`Error fetching transaction ${hash}:`, error);
      return null;
    }
  }

  /**
   * Gets a transaction receipt by hash from the specified network
   */
  async getTransactionReceipt(hash: Hash, network: NetworkType = 'L2'): Promise<any> {
    const cacheKey = `txReceipt:${network}:${hash}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.TRANSACTION);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      this.setCache(cacheKey, receipt);
      return receipt;
    } catch (error) {
      elizaLogger.error(`Error fetching transaction receipt ${hash}:`, error);
      return null;
    }
  }

  /**
   * Gets native token (ETH/MATIC) balance for an address on the specified network
   */
  async getNativeBalance(address: Address, network: NetworkType = 'L2'): Promise<bigint> {
    const cacheKey = `balance:${network}:${address}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.BALANCE);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    const balance = await client.getBalance({ address });
    
    this.setCache(cacheKey, balance);
    return balance;
  }

  /**
   * Gets ERC20 token balance for an address on the specified network
   */
  async getErc20Balance(tokenAddress: Address, holderAddress: Address, network: NetworkType = 'L2'): Promise<bigint> {
    const cacheKey = `erc20:${network}:${tokenAddress}:${holderAddress}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.BALANCE);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    
    try {
      // Use type assertion to avoid deep instantiation error
      const balance = await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [holderAddress]
      }) as unknown as bigint;
      
      this.setCache(cacheKey, balance);
      return balance;
    } catch (error) {
      elizaLogger.error(`Error fetching token balance for ${holderAddress} from ${tokenAddress}:`, error);
      return BigInt(0);
    }
  }

  /**
   * Gets ERC20 token metadata (symbol, decimals) on the specified network
   */
  async getErc20Metadata(tokenAddress: Address, network: NetworkType = 'L2'): Promise<{ symbol: string; decimals: number }> {
    const cacheKey = `erc20Meta:${network}:${tokenAddress}`;
    const cached = this.getCached(cacheKey, CACHE_EXPIRY.TOKEN_METADATA);
    
    if (cached !== undefined) {
      return cached;
    }
    
    const client = this.getPublicClient(network);
    
    try {
      const [symbolResult, decimalsResult] = await Promise.all([
        client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'symbol'
        }) as unknown as string,
        client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'decimals'
        }) as unknown as number
      ]);
      
      const metadata = { 
        symbol: symbolResult, 
        decimals: Number(decimalsResult) 
      };
      this.setCache(cacheKey, metadata);
      return metadata;
    } catch (error) {
      elizaLogger.error(`Error fetching token metadata for ${tokenAddress}:`, error);
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  /**
   * Helper method to get data from cache if it's still valid
   */
  private getCached(key: string, customExpiryMs?: number): any {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return undefined;
    }
    
    const now = Date.now();
    const expiryMs = customExpiryMs ?? this.defaultCacheExpiry;
    
    if (now - entry.timestamp > expiryMs) {
      this.cache.delete(key); // Clean up expired data
      return undefined;
    }
    
    return entry.data;
  }

  /**
   * Helper method to store data in the cache
   */
  private setCache(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Sends a transaction on the specified network
   */
  async sendTransaction(
    to: Address, 
    value: bigint = BigInt(0),
    data: Hash = '0x' as Hash,
    network: NetworkType = 'L2'
  ): Promise<Hash> {
    const client = this.getWalletClient(network);
    
    try {
      // Use type assertion to handle the complex type requirements
      const txHash = await client.sendTransaction({
        to,
        value,
        data,
        account: this.account
      } as any);
      
      elizaLogger.log(`Transaction sent on ${network}: ${txHash}`);
      return txHash;
    } catch (error) {
      elizaLogger.error(`Error sending transaction on ${network}:`, error);
      throw new Error(`Failed to send transaction: ${(error as Error).message}`);
    }
  }
}

/**
 * Initializes a PolygonRpcProvider instance from runtime settings
 */
export const initPolygonRpcProvider = async (runtime: IAgentRuntime): Promise<PolygonRpcProvider> => {
  // Try to get RPC URLs from runtime settings first, fall back to defaults if not provided
  const l1RpcUrl = runtime.getSetting('ETHEREUM_RPC_URL') || DEFAULT_RPC_URLS.ETHEREUM_RPC_URL;
  const l2RpcUrl = runtime.getSetting('POLYGON_RPC_URL') || DEFAULT_RPC_URLS.POLYGON_RPC_URL;
  const privateKey = runtime.getSetting('PRIVATE_KEY') as `0x${string}`;
  
  if (!privateKey) {
    throw new Error('Missing required configuration: PRIVATE_KEY');
  }
  
  elizaLogger.log(`Initializing PolygonRpcProvider with L1 URL: ${l1RpcUrl.substring(0, 20)}... and L2 URL: ${l2RpcUrl.substring(0, 20)}...`);
  
  return new PolygonRpcProvider(l1RpcUrl, l2RpcUrl, privateKey);
}; 