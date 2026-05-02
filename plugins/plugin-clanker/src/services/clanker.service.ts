import { Service, IAgentRuntime, logger } from '@elizaos/core';
import { Clanker } from 'clanker-sdk/v4';
import { Contract, JsonRpcProvider, parseUnits } from 'ethers';
import {
  createWalletClient,
  createPublicClient,
  http,
  PublicClient,
  WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains';
import {
  TokenDeployParams,
  DeployResult,
  TokenInfo,
  ClankerConfig,
  ErrorCode,
} from '../types';
import { ClankerError } from '../utils/errors';
import { retryTransaction } from '../utils/transactions';
import { loadClankerConfig } from '../utils/config';

export class ClankerService extends Service {
  static serviceType = 'clanker';
  capabilityDescription = '';
  private provider: JsonRpcProvider | null = null;
  private publicClient: PublicClient | null = null;
  private walletClient: WalletClient | null = null;
  private clanker: Clanker | null = null;
  private clankerConfig: ClankerConfig | null = null;
  private tokenCache: Map<string, TokenInfo> = new Map();
  private cacheTimeout = 60000; // 1 minute cache

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('Initializing Clanker service...');

    try {
      this.clankerConfig = loadClankerConfig();

      if (!this.clankerConfig) {
        throw new Error('Clanker configuration not found');
      }

      // Validate required config
      if (!this.clankerConfig.WALLET_PRIVATE_KEY) {
        throw new Error('PRIVATE_KEY is required for Clanker service');
      }

      if (!this.clankerConfig.BASE_RPC_URL) {
        throw new Error('BASE_RPC_URL is required for Clanker service');
      }

      // Initialize ethers provider for compatibility
      this.provider = new JsonRpcProvider(this.clankerConfig.BASE_RPC_URL);

      // Initialize viem clients
      const account = privateKeyToAccount(this.clankerConfig.WALLET_PRIVATE_KEY as `0x${string}`);

      const publicClient = createPublicClient({
        chain: base,
        transport: http(this.clankerConfig.BASE_RPC_URL),
      }) as PublicClient;

      this.publicClient = publicClient;
      
      const wallet = createWalletClient({
        account,
        chain: base,
        transport: http(this.clankerConfig.BASE_RPC_URL),
      });

      this.walletClient = wallet;

      
      // Initialize Clanker SDK
      this.clanker = new Clanker({
        wallet,
        publicClient,
      });
      
      // Test connections
      await publicClient.getChainId();
      await this.provider.getNetwork();

      logger.info('Clanker service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Clanker service:', error instanceof Error ? error.message : String(error));
      throw new ClankerError(
        ErrorCode.NETWORK_ERROR,
        'Failed to initialize Clanker service',
        error
      );
    }
  }

  static async start(runtime: IAgentRuntime): Promise<ClankerService> {
    const service = new ClankerService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async deployToken(params: TokenDeployParams): Promise<DeployResult> {
    logger.info(`Deploying token: ${params.name} (${params.symbol})`);

    if (!this.clanker || !this.clankerConfig || !this.walletClient) {
      throw new ClankerError(ErrorCode.PROTOCOL_ERROR, 'Service not initialized');
    }

    try {
      // Validate parameters
      if (!params.name || params.name.length > 50) {
        throw new ClankerError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid token name - must be 1-50 characters'
        );
      }

      if (!params.symbol || params.symbol.length > 10) {
        throw new ClankerError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid token symbol - must be 1-10 characters'
        );
      }

      // Prepare Clanker token configuration
      const tokenConfig: any = {
        name: params.name,
        symbol: params.symbol,
        tokenAdmin: this.walletClient.account?.address || params.tokenAdmin,
        vanity: params.vanity || false,
      };

      // Add optional image if provided
      if (params.image) {
        tokenConfig.image = params.image;
      }

      // Add metadata if provided
      if (params.metadata) {
        tokenConfig.metadata = {
          description: params.metadata.description || '',
          socialMediaUrls: params.metadata.socialMediaUrls || [],
          auditUrls: params.metadata.auditUrls || [],
        };
      }

      // Add context if provided
      if (params.context) {
        tokenConfig.context = {
          interface: params.context.interface || 'Clanker SDK',
          platform: params.context.platform || '',
          messageId: params.context.messageId || '',
          id: params.context.id || '',
        };
      }

      // Add pool configuration if provided
      if (params.pool) {
        tokenConfig.pool = params.pool;
      }

      // Add fee configuration if provided
      if (params.fees) {
        tokenConfig.fees = params.fees;
      }

      // Add rewards configuration if provided
      if (params.rewards) {
        tokenConfig.rewards = params.rewards;
      }

      // Add vault configuration if provided
      if (params.vault) {
        tokenConfig.vault = params.vault;
      }

      // Add dev buy configuration if provided
      if (params.devBuy) {
        tokenConfig.devBuy = params.devBuy;
      }

      // Deploy the token using Clanker SDK
      const deployResult = await retryTransaction(async () => {
        const { txHash, waitForTransaction, error } = await this.clanker!.deploy(tokenConfig);

        // The deploy function attempts to not throw and instead return an error
        // for you to decide how to handle
        if (error) throw error;

        // Wait for transaction to complete - this may also return an error
        const { address, error: waitError } = await waitForTransaction();
        if (waitError) throw waitError;

        return {
          contractAddress: address,
          transactionHash: txHash,
          deploymentCost: parseUnits('0', 18), // Clanker handles fees internally
          tokenId: `clanker_${params.symbol.toLowerCase()}_${Date.now()}`,
        };
      }, this.clankerConfig.RETRY_ATTEMPTS);

      logger.info(`Token deployed successfully: ${deployResult.contractAddress}`);

      // Cache the token info
      this.tokenCache.set(deployResult.contractAddress, {
        address: deployResult.contractAddress,
        name: params.name,
        symbol: params.symbol,
        decimals: 18, // Clanker tokens are 18 decimals by default
        totalSupply: parseUnits('1000000000', 18), // 1B tokens default
        createdAt: Date.now(),
      });

      return deployResult;
    } catch (error) {
      logger.error('Token deployment failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof ClankerError) throw error;

      throw new ClankerError(ErrorCode.PROTOCOL_ERROR, 'Token deployment failed', error);
    }
  }

  async fetchDexScreenerData(tokenAddress: string): Promise<{
    priceUsd: number;
    liquidityUsd: number;
    volumeUsd24h: number;
    marketCap: number;
  } | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
      const response = await fetch(url);
  
      if (!response.ok) {
        logger.warn(`DEX Screener request failed: ${response.status}`);
        return null;
      }
  
      const data: any = await response.json();
      const firstPair = data?.pairs?.[0];
  
      if (!firstPair) return null;
  
      return {
        priceUsd: parseFloat(firstPair.priceUsd || '0'),
        liquidityUsd: parseFloat(firstPair.liquidity?.usd || '0'),
        volumeUsd24h: parseFloat(firstPair.volume?.h24 || '0'),
        marketCap: parseFloat(firstPair.fdv || '0'),
      };
    } catch (error) {
      logger.warn('Failed to fetch from DEX Screener:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
  

  async getTokenInfo(address: string): Promise<TokenInfo> {
    logger.info('Getting token info for:', address);

    if (!this.provider || !this.clankerConfig) {
      throw new ClankerError(ErrorCode.PROTOCOL_ERROR, 'Service not initialized');
    }

    // Check cache first
    const cached = this.getCachedTokenInfo(address);
    if (cached && Date.now() - (cached.createdAt || 0) < this.cacheTimeout) {
      return cached;
    }

    try {
      // Query token contract directly
      const tokenAbi = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
        'function balanceOf(address) view returns (uint256)',
      ];

      const token = new Contract(address, tokenAbi, this.provider);

      const [name, symbol, decimals, totalSupply] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals(),
        token.totalSupply(),
      ]);

      const dexData = await this.fetchDexScreenerData(address);

      const priceUsd = dexData?.priceUsd || 0;
      const liquidity = dexData?.liquidityUsd || 0;
      const volume24h = dexData?.volumeUsd24h || 0;
      const marketCap = dexData?.marketCap || 0;

      const tokenInfo: TokenInfo = {
        address,
        name,
        symbol,
        decimals,
        totalSupply,
        price: priceUsd,
        priceUsd,
        liquidity,
        volume24h,
        marketCap,
        // holders: 0, // TODO: hook to indexer
        createdAt: Date.now(),
      };

      // Update cache
      this.tokenCache.set(address, tokenInfo);

      return tokenInfo;
    } catch (error) {
      logger.error('Failed to get token info:', error instanceof Error ? error.message : String(error));
      throw new ClankerError(
        ErrorCode.NETWORK_ERROR,
        'Failed to retrieve token information',
        error
      );
    }
  }

  async getAllTokensInWallet(): Promise<TokenInfo[]> {
    const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
    // ⚠️ This function is only supported if using Alchemy.
    // We assume the user is using Alchemy if ALCHEMY_API_KEY is present,
    // and that clankerConfig.BASE_RPC_URL is set to:
    // https://base-mainnet.g.alchemy.com/v2/<API_KEY>
    if (!this.walletClient || !this.walletClient.account || !this.clankerConfig || !ALCHEMY_API_KEY) {
      throw new ClankerError(ErrorCode.PROTOCOL_ERROR, 'Wallet not initialized');
    }
  
    const walletAddress = this.walletClient.account.address;
    
    try {
      // Step 1: Fetch token balances via Alchemy
      const response = await fetch(this.clankerConfig.BASE_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getTokenBalances',
          params: [walletAddress],
        }),
      });
  
      const json = await response.json() as any;
      const balances = json?.result?.tokenBalances || [];
  
      if (!Array.isArray(balances)) {
        throw new Error('Unexpected response format from Alchemy');
      }
  
      const tokenInfos: TokenInfo[] = [];
  
      // Step 2: Loop and enrich token info
      for (const { contractAddress, tokenBalance } of balances) {
        try {
          const info = await this.getTokenInfo(contractAddress);
          if (info && BigInt(tokenBalance) > 0n) {
            tokenInfos.push(info);
          }
        } catch (err) {
          logger.warn(`⚠️ Skipping token ${contractAddress}:`, err instanceof Error ? err.message : String(err));
        }
      }
  
      logger.info(`✅ Found ${tokenInfos.length} tokens with non-zero balance`);
      return tokenInfos;
    } catch (error) {
      logger.error('Failed to fetch wallet tokens from Alchemy:', error instanceof Error ? error.message : String(error));
      throw new ClankerError(
        ErrorCode.NETWORK_ERROR,
        'Could not retrieve token balances from Alchemy',
        error
      );
    }
  }
  

  async resolveTokenAddressBySymbol(symbolOrName: string): Promise<string | null> {
    const query = symbolOrName.toLowerCase();
  
    // 1. Check known tokens
    const knownTokens: Record<string, string> = {
      eth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      weth: '0x4200000000000000000000000000000000000006',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
  
    if (knownTokens[query]) {
      return knownTokens[query];
    }
  
    // 2. Check cache
    const cachedMatch = [...this.tokenCache.values()].find(
      (token) =>
        token.symbol.toLowerCase() === query ||
        token.name.toLowerCase() === query
    );
  
    if (cachedMatch) {
      return cachedMatch.address;
    }
  
    // 3. Fallback: query all wallet tokens from Alchemy
    try {
      const allTokens = await this.getAllTokensInWallet();
  
      const match = allTokens.find(
        (token) =>
          token.symbol.toLowerCase() === query ||
          token.name.toLowerCase() === query
      );
  
      return match?.address || null;
    } catch (err) {
      logger.warn('resolveTokenAddressBySymbol fallback failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }  


  getCachedTokenInfo(address: string): TokenInfo | null {
    return this.tokenCache.get(address) || null;
  }

  async stop(): Promise<void> {
    logger.info('Stopping Clanker service...');
    this.tokenCache.clear();
    this.provider = null;
    this.walletClient = null;
    this.clanker = null;
    this.clankerConfig = null;
  }
}
