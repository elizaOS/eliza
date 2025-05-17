import { Service, IAgentRuntime, logger } from '@elizaos/core';
import {
  JsonRpcProvider,
  Contract,
  Wallet
} from 'ethers'; // Importing directly from ethers v6+

// viem imports for RPC client operations
import {
  type Address,
  type Hash,
  type Hex,
  formatEther,
  parseEther,
  type Chain
} from 'viem';

// Import our new provider
import { PolygonRpcProvider, initPolygonRpcProvider } from '../providers/PolygonRpcProvider.js';
import { NetworkType, Transaction, BlockIdentifier, BlockInfo, TransactionDetails, CacheEntry } from '../types.js';
import { DEFAULT_RPC_URLS, CONTRACT_ADDRESSES, CACHE_EXPIRY } from '../config.js';

// Import ABIs from contract files
import StakeManagerABI from '../contracts/StakeManagerABI.json' with { type: "json" };
import ValidatorShareABI from '../contracts/ValidatorShareABI.json' with { type: "json" };
import RootChainManagerABI from '../contracts/RootChainManagerABI.json' with { type: "json" };
import ERC20ABI from '../contracts/ERC20ABI.json' with { type: "json" };

// Re-import GasService components
import { getGasPriceEstimates, GasPriceEstimates } from './GasService.js';

// --- Staking Contract Addresses (Ethereum Mainnet) ---
const STAKE_MANAGER_ADDRESS_L1 = CONTRACT_ADDRESSES.STAKE_MANAGER_ADDRESS_L1;
const ROOT_CHAIN_MANAGER_ADDRESS_L1 = CONTRACT_ADDRESSES.ROOT_CHAIN_MANAGER_ADDRESS_L1;

// --- Type Definitions for Staking Info ---

// Enum mapping based on StakeManager contract inspection (adjust if needed)
export enum ValidatorStatus { // Renamed for clarity
  Inactive = 0,
  Active = 1,
  Unbonding = 2,
  Jailed = 3,
}

export interface ValidatorInfo {
  status: ValidatorStatus;
  totalStake: bigint; // Combined self-stake + delegated amount
  commissionRate: number; // Percentage (e.g., 0.1 for 10%)
  signerAddress: string;
  activationEpoch: bigint;
  deactivationEpoch: bigint;
  jailEndEpoch: bigint;
  contractAddress: string; // Address of the ValidatorShare contract
  lastRewardUpdateEpoch: bigint;
  // Add other relevant fields from the struct if needed
}

export interface DelegatorInfo {
  delegatedAmount: bigint;
  pendingRewards: bigint;
}

/**
 * Service for interacting with Ethereum (L1) and Polygon (L2) networks.
 * Provides methods for both standard RPC operations and Polygon-specific functionality.
 */
export class PolygonRpcService extends Service {
  static serviceType = 'polygonRpc';
  capabilityDescription =
    'Provides access to Ethereum (L1) and Polygon (L2) JSON-RPC nodes and L1 staking operations.';

  // Legacy ethers.js providers - keep for compatibility with existing code
  private l1Provider: JsonRpcProvider | null = null;
  private l2Provider: JsonRpcProvider | null = null;
  private l1Signer: Wallet | null = null;
  private stakeManagerContractL1: Contract | null = null;
  private rootChainManagerContractL1: Contract | null = null;
  
  // New viem-based provider for standardized RPC operations
  private rpcProvider: PolygonRpcProvider | null = null;
  
  // Cache settings
  private cacheKey = 'polygon/rpc';
  private cacheExpiryMs = 60000; // 1 minute

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  /**
   * Initializes providers for both L1 and L2 networks.
   */
  private async initializeProviders(): Promise<void> {
    if (!this.runtime) {
      throw new Error('Runtime required for provider initialization');
    }

    try {
      // Initialize viem-based provider
      this.rpcProvider = await initPolygonRpcProvider(this.runtime);
      
      // Initialize legacy ethers.js providers for backward compatibility
      const l1RpcUrl = this.runtime.getSetting('ETHEREUM_RPC_URL') || DEFAULT_RPC_URLS.ETHEREUM_RPC_URL;
      const l2RpcUrl = this.runtime.getSetting('POLYGON_RPC_URL') || DEFAULT_RPC_URLS.POLYGON_RPC_URL;
      const privateKey = this.runtime.getSetting('PRIVATE_KEY');
    
      if (!privateKey) {
        throw new Error('Missing required private key');
      }

      this.l1Provider = new JsonRpcProvider(l1RpcUrl);
      this.l2Provider = new JsonRpcProvider(l2RpcUrl);
      this.l1Signer = new Wallet(privateKey, this.l1Provider);

      // Initialize contract instances
      this.stakeManagerContractL1 = new Contract(
        STAKE_MANAGER_ADDRESS_L1,
        StakeManagerABI,
        this.l1Provider
      );
      
      this.rootChainManagerContractL1 = new Contract(
        ROOT_CHAIN_MANAGER_ADDRESS_L1,
        RootChainManagerABI,
        this.l1Signer
      );
      
      logger.info('PolygonRpcService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PolygonRpcService:', error);
      // Reset all components on failure
      this.l1Provider = null;
      this.l2Provider = null;
      this.l1Signer = null;
      this.stakeManagerContractL1 = null;
      this.rootChainManagerContractL1 = null;
      this.rpcProvider = null;
      throw error;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<PolygonRpcService> {
    logger.info(`Starting PolygonRpcService...`);
    const service = new PolygonRpcService(runtime);
    await service.initializeProviders();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping PolygonRpcService...');
    const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    logger.info('PolygonRpcService instance stopped.');
    this.l1Provider = null;
    this.l2Provider = null;
    this.l1Signer = null;
    this.stakeManagerContractL1 = null;
    this.rootChainManagerContractL1 = null;
    this.rpcProvider = null;
  }

  // --- Standard RPC Methods with Network Selection ---

  /**
   * Gets the current block number for the specified network
   */
  async getBlockNumber(network: NetworkType = 'L2'): Promise<number> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    return this.rpcProvider.getBlockNumber(network);
  }

  /**
   * Gets the balance of native tokens (ETH/MATIC) for an address on the specified network
   */
  async getBalance(address: Address, network: NetworkType = 'L2'): Promise<bigint> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    return this.rpcProvider.getNativeBalance(address, network);
  }

  /**
   * Gets transaction details by hash from the specified network
   */
  async getTransaction(txHash: Hash, network: NetworkType = 'L2'): Promise<any> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    return this.rpcProvider.getTransaction(txHash, network);
  }

  /**
   * Gets transaction receipt by hash from the specified network
   */
  async getTransactionReceipt(txHash: Hash, network: NetworkType = 'L2'): Promise<any> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    return this.rpcProvider.getTransactionReceipt(txHash, network);
  }

  /**
   * Gets block details by number or hash from the specified network
   */
  async getBlock(blockIdentifier: BlockIdentifier, network: NetworkType = 'L2'): Promise<any> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    return this.rpcProvider.getBlock(blockIdentifier, network);
  }

  /**
   * Performs a contract call on the specified network
   */
  async call(
    to: Address, 
    data: Hash, 
    network: NetworkType = 'L2'
  ): Promise<Hash> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    const client = this.rpcProvider.getPublicClient(network);
    const result = await client.call({
      to,
      data,
    });
    
    return result.data as Hash;
  }

  /**
   * Estimates gas for a transaction on the specified network
   */
  async estimateGas(
    tx: { to: Address; data?: Hash; value?: bigint },
    network: NetworkType = 'L2'
  ): Promise<bigint> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    const client = this.rpcProvider.getPublicClient(network);
    const account = this.rpcProvider.getAddress();
    
    const gasEstimate = await client.estimateGas({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      account,
    });
    
    return gasEstimate;
  }

  /**
   * Gets current gas price on the specified network
   */
  async getGasPrice(network: NetworkType = 'L2'): Promise<bigint> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    const client = this.rpcProvider.getPublicClient(network);
    const gasPrice = await client.getGasPrice();
    
    return gasPrice;
  }

  /**
   * Sends a transaction on the specified network
   */
  async sendTransaction(
    to: Address,
    value: bigint,
    data: Hash = '0x' as Hash,
    network: NetworkType = 'L2'
  ): Promise<Hash> {
    if (!this.rpcProvider) {
      throw new Error('RPC Provider not initialized');
    }
    
    try {
      // Use the provider's sendTransaction method which is safer and properly handles gas estimation
      const txHash = await this.rpcProvider.sendTransaction(to, value, data, network);
      logger.info(`Transaction sent on ${network}: ${txHash}`);
      
      return txHash;
    } catch (error) {
      logger.error(`Error sending transaction on ${network}:`, error);
      throw new Error(`Failed to send transaction: ${error.message}`);
    }
  }

  // --- Convenience Methods for L1/L2 Specific Operations ---

  /**
   * Gets the current Ethereum (L1) block number
   */
  async getCurrentL1BlockNumber(): Promise<number> {
    return this.getBlockNumber('L1');
  }

  /**
   * Gets the current Polygon (L2) block number
   */
  async getCurrentL2BlockNumber(): Promise<number> {
    return this.getBlockNumber('L2');
  }

  /**
   * Gets ETH balance for an address on Ethereum (L1)
   */
  async getNativeL1Balance(address: Address): Promise<bigint> {
    return this.getBalance(address, 'L1');
  }

  /**
   * Gets MATIC balance for an address on Polygon (L2)
   */
  async getNativeL2Balance(address: Address): Promise<bigint> {
    return this.getBalance(address, 'L2');
  }

  // --- The Five Basic Read Functions ---
  
  /**
   * Gets the current block number from Polygon (L2)
   * This is a convenient wrapper over getCurrentL2BlockNumber for better semantic naming
   * 
   * @returns The latest block number on the Polygon network
   */
  async getCurrentBlockNumber(): Promise<number> {
    try {
      const cacheKey = `${this.cacheKey}/currentBlockNumber`;
      const cachedBlockNumber = await this.getCachedValue<number>(cacheKey);
      
      if (cachedBlockNumber) {
        logger.debug('Returning cached current block number');
        return cachedBlockNumber;
      }
      
      logger.info('Fetching current Polygon block number');
      const blockNumber = await this.getBlockNumber('L2');
      
      // Cache block number with shorter expiry (10 seconds)
      await this.setCacheValue(cacheKey, blockNumber, 10000);
      return blockNumber;
    } catch (error) {
      logger.error('Error getting current block number:', error);
      throw new Error(`Failed to get current block number: ${error.message}`);
    }
  }

  /**
   * Gets detailed block information by number or hash from Polygon (L2)
   * 
   * @param identifier Block number or hash
   * @returns Detailed block information including transactions
   */
  async getBlockDetails(identifier: BlockIdentifier): Promise<BlockInfo> {
    try {
      // Create cache key based on block identifier
      const cacheKey = `${this.cacheKey}/block/${typeof identifier === 'number' ? 'num_' + identifier : identifier}`;
      const cachedBlock = await this.getCachedValue<BlockInfo>(cacheKey);
      
      if (cachedBlock) {
        logger.debug(`Returning cached block details for ${identifier}`);
        return cachedBlock;
      }
      
      logger.info(`Fetching details for block ${identifier}`);
      
      // Fetch block with full transaction objects
      const block = await this.rpcProvider!.getBlock(identifier, 'L2');
      
      if (!block) {
        throw new Error(`Block not found: ${identifier}`);
      }
      
      // Transform block into our standardized format
      const blockInfo: BlockInfo = {
        number: Number(block.number),
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        nonce: block.nonce,
        difficulty: block.difficulty,
        gasLimit: block.gasLimit,
        gasUsed: block.gasUsed,
        miner: block.miner,
        extraData: block.extraData,
        baseFeePerGas: block.baseFeePerGas,
        transactions: block.transactions
      };
      
      // Cache the result for 60 seconds
      await this.setCacheValue(cacheKey, blockInfo, 60000);
      return blockInfo;
    } catch (error) {
      logger.error(`Error getting block details for ${identifier}:`, error);
      throw new Error(`Failed to get block details: ${error.message}`);
    }
  }
  
  /**
   * Gets detailed transaction information by hash from Polygon (L2)
   * 
   * @param txHash Transaction hash
   * @returns Transaction details and receipt
   */
  async getTransactionDetails(txHash: Hash): Promise<TransactionDetails | null> {
    try {
      // Check cache first
      const cacheKey = `${this.cacheKey}/tx/${txHash}`;
      const cachedTx = await this.getCachedValue<TransactionDetails>(cacheKey);
      
      if (cachedTx) {
        logger.debug(`Returning cached transaction details for ${txHash}`);
        return cachedTx;
      }
      
      logger.info(`Fetching details for transaction ${txHash}`);
      
      // Fetch both transaction and receipt in parallel
      const [txResponse, txReceipt] = await Promise.all([
        this.rpcProvider!.getTransaction(txHash, 'L2'),
        this.rpcProvider!.getTransactionReceipt(txHash, 'L2')
      ]);
      
      // If neither is found, return null
      if (!txResponse && !txReceipt) {
        logger.info(`Transaction ${txHash} not found`);
        return null;
      }
      
      // Format the result
      const result: TransactionDetails = {
        transaction: txResponse,
        receipt: txReceipt
      };
      
      // Cache the result permanently (transaction data doesn't change)
      await this.setCacheValue(cacheKey, result);
      return result;
    } catch (error) {
      logger.error(`Error getting transaction details for ${txHash}:`, error);
      throw new Error(`Failed to get transaction details: ${error.message}`);
    }
  }

  /**
   * Gets MATIC balance for an address on Polygon (L2)
   * 
   * @param address The address to check
   * @returns Native MATIC balance in wei (as bigint)
   */
  async getNativeBalance(address: Address): Promise<bigint> {
    try {
      if (!address.startsWith('0x')) {
        throw new Error('Invalid address format');
      }
      
      // Check cache first
      const cacheKey = `${this.cacheKey}/balance/${address.toLowerCase()}`;
      const cachedBalance = await this.getCachedValue<bigint>(cacheKey);
      
      if (cachedBalance !== undefined) {
        logger.debug(`Returning cached MATIC balance for ${address}`);
        return cachedBalance;
      }
      
      logger.info(`Fetching MATIC balance for ${address}`);
      
      // Get balance using the provider
      const balance = await this.rpcProvider!.getNativeBalance(address, 'L2');
      
      // Cache for 30 seconds (balances may change frequently)
      await this.setCacheValue(cacheKey, balance, 30000);
      return balance;
    } catch (error) {
      logger.error(`Error getting MATIC balance for ${address}:`, error);
      throw new Error(`Failed to get MATIC balance: ${error.message}`);
    }
  }

  /**
   * Gets token balance for an ERC20 token on Polygon (L2)
   * 
   * @param tokenAddress The token contract address
   * @param accountAddress The address holding the tokens
   * @returns Token balance in the smallest denomination (as bigint)
   */
  async getErc20Balance(tokenAddress: Address, accountAddress: Address): Promise<bigint> {
    try {
      if (!tokenAddress.startsWith('0x') || !accountAddress.startsWith('0x')) {
        throw new Error('Invalid address format');
      }
      
      // Check cache first
      const cacheKey = `${this.cacheKey}/erc20/${tokenAddress.toLowerCase()}/${accountAddress.toLowerCase()}`;
      const cachedBalance = await this.getCachedValue<bigint>(cacheKey);
      
      if (cachedBalance !== undefined) {
        logger.debug(`Returning cached token balance for ${accountAddress} (token: ${tokenAddress})`);
        return cachedBalance;
      }
      
      logger.info(`Fetching token balance for ${accountAddress} (token: ${tokenAddress})`);
      
      // Get token balance using the provider
      const balance = await this.rpcProvider!.getErc20Balance(tokenAddress, accountAddress, 'L2');
      
      // Cache for 30 seconds (balances may change frequently)
      await this.setCacheValue(cacheKey, balance, 30000);
      return balance;
    } catch (error) {
      logger.error(`Error getting token balance for ${accountAddress} (token: ${tokenAddress}):`, error);
      throw new Error(`Failed to get token balance: ${error.message}`);
    }
  }

  // --- Cache Helpers ---
  
  /**
   * Gets a value from the cache if it exists and hasn't expired
   */
  private async getCachedValue<T>(key: string): Promise<T | undefined> {
    if (!this.runtime) {
      return undefined;
    }
    
    try {
      const cache = await this.runtime.getCache<CacheEntry<T>>(key);
      
      if (!cache) {
        return undefined;
      }
      
      // Check if cache has expired
      const now = Date.now();
      if (now - cache.timestamp > this.cacheExpiryMs) {
        // Clean up expired cache
        await this.runtime.deleteCache(key);
        return undefined;
      }
      
      return cache.value;
      } catch (error) {
      logger.error(`Error retrieving from cache (${key}):`, error);
      return undefined;
    }
  }
  
  /**
   * Sets a value in the cache with timestamp
   */
  private async setCacheValue<T>(key: string, value: T, expiryMs?: number): Promise<void> {
    if (!this.runtime) {
      return;
    }
    
    try {
      const cacheEntry: CacheEntry<T> = {
        value,
        timestamp: Date.now()
      };
      
      // Set custom expiry if provided, otherwise use default from config
      if (expiryMs) {
        this.cacheExpiryMs = expiryMs;
      } else {
        this.cacheExpiryMs = CACHE_EXPIRY.DEFAULT;
      }
      
      await this.runtime.setCache(key, cacheEntry);
    } catch (error) {
      logger.error(`Error setting cache (${key}):`, error);
    }
  }

  /**
   * Gets the ethers provider for the specified network
   * This is needed for compatibility with contracts that require ethers.js
   */
  getEthersProvider(network: NetworkType = 'L2'): JsonRpcProvider {
    if (network === 'L1') {
      if (!this.l1Provider) {
        throw new Error('L1 provider not initialized');
      }
      return this.l1Provider;
    } else {
      if (!this.l2Provider) {
        throw new Error('L2 provider not initialized');
      }
      return this.l2Provider;
    }
  }
}
