// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime } from "@elizaos/core";
import { Service, logger } from "@elizaos/core";

// Import Steer Protocol SDK
import {
  SteerClient,
  VaultClient,
  StakingClient,
  AMMType,
} from "@steerprotocol/sdk";

// Import Viem for proper chain and transport configuration
import { mainnet, polygon, arbitrum, optimism, base } from "viem/chains";
import { createPublicClient, http } from "viem";

// Supported chain IDs
const SUPPORTED_CHAIN_IDS = [1, 137, 42161, 10, 8453]; // mainnet, polygon, arbitrum, optimism, base

// GraphQL endpoint for Steer Protocol
const STEER_GRAPHQL_ENDPOINT =
  "https://api.subgraph.ormilabs.com/api/public/803c8c8c-be12-4188-8523-b9853e23051d/subgraphs/steer-protocol-base/prod/gn";

// Interfaces for type safety
interface TokenLiquidityStats {
  tokenIdentifier: string;
  normalizedToken: string;
  tokenName: string;
  timestamp: string;
  vaults: any[];
  stakingPools: any[];
  totalTvl: number;
  totalVolume: number;
  apyRange: { min: number; max: number };
  vaultCount: number;
  stakingPoolCount: number;
}

interface ConnectionTestResult {
  connectionTest: boolean;
  supportedChains: number[];
  vaultCount: number;
  stakingPoolCount: number;
  error?: string;
}

// GraphQL Vault Data Interface
interface GraphQLVaultData {
  id: string;
  name: string;
  token0: string;
  token1: string;
  pool: string;
  weeklyFeeAPR: string;
  token0Symbol: string;
  token0Decimals: string;
  token1Symbol: string;
  token1Decimals: string;
  token0Balance: string;
  token1Balance: string;
  totalLPTokensIssued: string;
  feeTier: string;
  fees0: string;
  fees1: string;
  strategyToken: {
    id: string;
    name: string;
    creator: {
      id: string;
    };
    admin: string;
    executionBundle: string;
  };
  beaconName: string;
  payloadIpfs: string;
  deployer: string;
}

interface GraphQLResponse {
  data: {
    vault: GraphQLVaultData;
  };
}

/**
 * Steer Finance Liquidity Protocol Service
 * Handles interactions with Steer Finance protocol using the official SDK
 */
export class SteerLiquidityService extends Service {
  private isRunning = false;
  private supportedChains: number[];
  private steerClient: SteerClient;
  private vaultClients: Map<number, VaultClient> = new Map();
  private stakingClients: Map<number, StakingClient> = new Map();
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

  static serviceType = "STEER_LIQUIDITY_SERVICE";
  static serviceName = "SteerLiquidityService";
  capabilityDescription =
    "Provides detailed access to Steer Finance vaults and staking pools for specific tokens using the official SDK." as const;

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Initialize supported chains
    this.supportedChains = SUPPORTED_CHAIN_IDS;

    // Initialize Steer SDK client
    try {
      // Create a proper Viem client configuration for each chain
      const viemClient = createPublicClient({
        chain: mainnet,
        transport: http(),
      });

      this.steerClient = new SteerClient({
        client: viemClient,
      });
      logger.log("Steer SDK client initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize Steer SDK client:", error);
      throw new Error("Steer SDK initialization failed");
    }

    // Initialize vault and staking clients for each supported chain
    this.initializeChainClients();

    logger.log("SteerLiquidityService initialized with multi-chain support");
    logger.log(`Supported chains: ${this.supportedChains.join(", ")}`);
    logger.log(
      "SteerLiquidityService ready to handle requests using official SDK",
    );

    // Verify runtime has required methods
    if (!runtime.getService) {
      logger.warn("Runtime missing getService method");
    }
    if (!runtime.getCache) {
      logger.warn("Runtime missing getCache method");
    }

    // Log successful initialization
    logger.log("SteerLiquidityService constructor completed successfully");
  }

  /**
   * Get the appropriate Viem chain object for a given chain ID
   */
  private getViemChain(chainId: number) {
    switch (chainId) {
      case 1:
        return mainnet;
      case 137:
        return polygon;
      case 42161:
        return arbitrum;
      case 10:
        return optimism;
      case 8453:
        return base;
      default:
        return mainnet;
    }
  }

  /**
   * Initialize vault and staking clients for each supported chain
   */
  private initializeChainClients(): void {
    try {
      for (const chainId of this.supportedChains) {
        // Get the appropriate Viem chain object
        const viemChain = this.getViemChain(chainId);

        // Create Viem clients for this chain
        const publicClient = createPublicClient({
          chain: viemChain,
          transport: http(),
        });

        const walletClient = createPublicClient({
          chain: viemChain,
          transport: http(),
        });

        // Initialize vault client for this chain
        const vaultClient = new VaultClient(
          publicClient as any,
          walletClient as any,
          "production",
        );
        this.vaultClients.set(chainId, vaultClient);

        // Initialize staking client for this chain
        const stakingClient = new StakingClient(publicClient as any);
        this.stakingClients.set(chainId, stakingClient);

        logger.log(`Initialized clients for chain ${chainId}`);
      }
      logger.log(
        `Successfully initialized clients for ${this.supportedChains.length} chains`,
      );
    } catch (error) {
      logger.error("Error initializing chain clients:", error);
      throw new Error("Failed to initialize chain clients");
    }
  }

  /**
   * Get token liquidity information from Steer Finance across all supported chains or a specific chain
   */
  async getTokenLiquidityStats(
    tokenIdentifier: string,
    targetChainId?: number | null,
  ): Promise<TokenLiquidityStats> {
    try {
      logger.log(`Getting Steer liquidity info for token: ${tokenIdentifier}`);
      if (targetChainId) {
        logger.log(
          `Chain filtering enabled - targeting chain: ${targetChainId}`,
        );
      }

      // Normalize token identifier
      const normalizedToken = this.normalizeTokenIdentifier(tokenIdentifier);
      const tokenName = this.getTokenName(normalizedToken);

      const allVaults: any[] = [];
      const allStakingPools: any[] = [];

      // Determine which chains to search
      let chainsToSearch: number[];
      if (targetChainId) {
        // Validate that the target chain is supported
        if (!this.supportedChains.includes(targetChainId)) {
          throw new Error(
            `Chain ${targetChainId} is not supported. Supported chains: ${this.supportedChains.join(", ")}`,
          );
        }
        chainsToSearch = [targetChainId];
        logger.log(
          `Chain filtering enabled - targeting chain: ${targetChainId} (${this.getChainName(targetChainId)})`,
        );
      } else {
        chainsToSearch = this.supportedChains;
        logger.log(
          `No chain filter specified - searching all supported chains: ${chainsToSearch.join(", ")}`,
        );
      }

      // Check if this is a token address for targeted search
      const isTokenAddress =
        tokenIdentifier.startsWith("0x") && tokenIdentifier.length === 42;

      if (isTokenAddress) {
        logger.log(
          `Token address detected, searching for specific vaults containing ${tokenIdentifier}`,
        );

        // Search for vaults containing the specific token using SDK
        for (const chainId of chainsToSearch) {
          try {
            logger.log(
              `Searching for token ${tokenIdentifier} on chain ${chainId}...`,
            );
            const tokenVaults = await this.getVaultsForToken(
              chainId,
              tokenIdentifier,
            );

            if (tokenVaults && tokenVaults.length > 0) {
              allVaults.push(...tokenVaults);
              logger.log(
                `Chain ${chainId}: Found ${tokenVaults.length} vaults containing token ${tokenIdentifier}`,
              );
            } else {
              logger.log(
                `Chain ${chainId}: No vaults found containing token ${tokenIdentifier}`,
              );
            }
          } catch (error) {
            logger.error(
              `Error searching for token ${tokenIdentifier} on chain ${chainId}:`,
              error,
            );
          }
        }

        if (allVaults.length === 0) {
          logger.log(
            `No vaults found containing token ${tokenIdentifier}, falling back to general search...`,
          );
        }
      }

      // If no specific token vaults found or this is a general search, get all vaults
      if (allVaults.length === 0) {
        logger.log(`Fetching all vault data from Steer Finance using SDK...`);

        // Fetch data from specified chains using the SDK
        for (const chainId of chainsToSearch) {
          try {
            logger.log(`Fetching data for chain ${chainId}...`);

            // Get vaults for this chain using SDK
            const chainVaults = await this.getAllVaultsForChain(chainId);
            allVaults.push(...chainVaults);

            logger.log(
              `Chain ${chainId}: Successfully processed ${chainVaults.length} vaults`,
            );
          } catch (error) {
            logger.error(`Error fetching data for chain ${chainId}:`, error);
          }
        }
      }

      logger.log(
        `Total vaults processed across ${chainsToSearch.length} chain(s): ${allVaults.length}`,
      );

      // Calculate aggregate statistics
      const totalTvl = allVaults.reduce(
        (sum, vault) => sum + (vault.tvl || 0),
        0,
      );
      const totalVolume = allVaults.reduce(
        (sum, vault) => sum + (vault.volume24h || 0),
        0,
      );
      const apyValues = allVaults
        .map((vault) => vault.apy || vault.apr || 0)
        .filter((apy) => apy > 0);
      const apyRange = {
        min: apyValues.length > 0 ? Math.min(...apyValues) : 0,
        max: apyValues.length > 0 ? Math.max(...apyValues) : 0,
      };

      // Log summary of what was found
      logger.log(`=== STEER LIQUIDITY STATS SUMMARY ===`);
      logger.log(`Total vaults found: ${allVaults.length}`);
      logger.log(`Total staking pools found: ${allStakingPools.length}`);
      logger.log(`Total TVL: $${totalTvl.toLocaleString()}`);
      logger.log(`Total 24h Volume: $${totalVolume.toLocaleString()}`);
      logger.log(
        `APY Range: ${apyRange.min.toFixed(2)}% - ${apyRange.max.toFixed(2)}%`,
      );

      // Log breakdown by chain
      const vaultsByChain = allVaults.reduce(
        (acc, vault) => {
          acc[vault.chainId] = (acc[vault.chainId] || 0) + 1;
          return acc;
        },
        {} as { [key: number]: number },
      );

      logger.log(`Vaults by chain:`, vaultsByChain);

      const stats: TokenLiquidityStats = {
        tokenIdentifier,
        normalizedToken,
        tokenName,
        timestamp: new Date().toISOString(),
        vaults: allVaults,
        stakingPools: allStakingPools,
        totalTvl,
        totalVolume,
        apyRange,
        vaultCount: allVaults.length,
        stakingPoolCount: allStakingPools.length,
      };

      const chainInfo = targetChainId
        ? ` on ${this.getChainName(targetChainId)}`
        : " across all chains";
      logger.log(
        `Found ${stats.vaultCount} vaults and ${stats.stakingPoolCount} staking pools for ${normalizedToken}${chainInfo} with total TVL: $${stats.totalTvl.toLocaleString()}`,
      );

      return stats;
    } catch (error) {
      logger.error("Error getting Steer liquidity stats:", error);
      throw new Error(
        `Failed to get Steer liquidity stats: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get all vaults for a specific chain using the SDK
   */
  private async getAllVaultsForChain(chainId: number): Promise<any[]> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        logger.warn(`No vault client available for chain ${chainId}`);
        return [];
      }

      // Get all vaults for the chain using SDK
      let vaultsResponse;
      try {
        vaultsResponse = await vaultClient.getVaults({ chainId }, 100, null);
      } catch (error) {
        logger.error(`API call failed for chain ${chainId}:`, error);
        return [];
      }

      if (!vaultsResponse.success || !vaultsResponse.data) {
        logger.warn(
          `Failed to get vaults for chain ${chainId}: ${vaultsResponse.error || "Unknown error"}`,
        );
        // If it's a server error, log it but continue with other chains
        if (vaultsResponse.error?.includes("INTERNAL_SERVER_ERROR")) {
          logger.warn(`Chain ${chainId} has server issues, skipping for now`);
        }
        return [];
      }

      // Debug: Log the response structure
      logger.log(`Vault response structure for chain ${chainId}:`, {
        success: vaultsResponse.success,
        hasData: !!vaultsResponse.data,
        dataType: typeof vaultsResponse.data,
        isArray: Array.isArray(vaultsResponse.data),
        hasEdges: !!vaultsResponse.data?.edges,
        edgesLength: vaultsResponse.data?.edges?.length || 0,
      });

      // Extract vaults from the paginated response structure
      const vaults =
        vaultsResponse.data?.edges?.map((edge: any) => edge.node) || [];
      logger.log(
        `Retrieved ${vaults.length} vaults from SDK for chain ${chainId}`,
      );

      // Process and enrich vault data
      const processedVaults = await Promise.all(
        vaults.map(async (vault) => {
          try {
            return await this.processVaultData(vault, chainId);
          } catch (error) {
            logger.error(`Error processing vault ${vault.address}:`, error);
            return null;
          }
        }),
      );

      return processedVaults.filter((vault) => vault !== null);
    } catch (error) {
      logger.error(`Error getting vaults for chain ${chainId}:`, error);
      return [];
    }
  }

  /**
   * Get vaults for a specific token on a specific chain using SDK
   */
  private async getVaultsForToken(
    chainId: number,
    tokenAddress: string,
  ): Promise<any[]> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        logger.warn(`No vault client available for chain ${chainId}`);
        return [];
      }

      // Get all vaults for the chain
      let vaultsResponse;
      try {
        vaultsResponse = await vaultClient.getVaults({ chainId }, 100, null);
      } catch (error) {
        logger.error(`API call failed for chain ${chainId}:`, error);
        return [];
      }

      if (!vaultsResponse.success || !vaultsResponse.data) {
        logger.warn(
          `Failed to get vaults for chain ${chainId}: ${vaultsResponse.error || "Unknown error"}`,
        );
        return [];
      }

      // Extract vaults from the paginated response structure
      const allVaults =
        vaultsResponse.data?.edges?.map((edge: any) => edge.node) || [];
      logger.log(
        `Searching ${allVaults.length} vaults for token ${tokenAddress} on chain ${chainId}`,
      );

      // Debug: Log first vault structure to understand the data format
      if (allVaults.length > 0) {
        logger.log(`Sample vault structure for chain ${chainId}:`, {
          vaultAddress: allVaults[0].vaultAddress,
          address: allVaults[0].address,
          token0: allVaults[0].token0,
          token1: allVaults[0].token1,
          token0Type: typeof allVaults[0].token0,
          token1Type: typeof allVaults[0].token1,
          pool: allVaults[0].pool,
        });
      }

      const matchingVaults: any[] = [];

      // Filter vaults that contain the target token
      for (const vault of allVaults) {
        try {
          // Check if the vault contains the target token
          if (this.vaultContainsToken(vault, tokenAddress)) {
            logger.log(
              `Found matching vault ${vault.vaultAddress || vault.address} for token ${tokenAddress}`,
            );

            // Process the vault data
            const processedVault = await this.processVaultData(vault, chainId);
            if (processedVault) {
              matchingVaults.push(processedVault);
            }
          }
        } catch (error) {
          logger.log(`Error processing vault ${vault.address}:`, error);
        }
      }

      logger.log(
        `Found ${matchingVaults.length} vaults containing token ${tokenAddress} on chain ${chainId}`,
      );
      return matchingVaults;
    } catch (error) {
      logger.error(
        `Error getting vaults for token ${tokenAddress} on chain ${chainId}:`,
        error,
      );
      return [];
    }
  }

  /**
   * Check if a vault contains a specific token
   */
  private vaultContainsToken(vault: any, tokenAddress: string): boolean {
    const targetAddress = tokenAddress.toLowerCase();

    // Check token0 and token1 - handle both string and object formats
    const token0Address =
      typeof vault.token0 === "string" ? vault.token0 : vault.token0?.address;
    const token1Address =
      typeof vault.token1 === "string" ? vault.token1 : vault.token1?.address;

    if (
      token0Address?.toLowerCase() === targetAddress ||
      token1Address?.toLowerCase() === targetAddress
    ) {
      return true;
    }

    // Check pool address if available
    if (vault.poolAddress) {
      return true;
    }

    return false;
  }

  /**
   * Process vault data from SDK response
   */
  private async processVaultData(vault: any, chainId: number): Promise<any> {
    try {
      // Extract basic vault information
      const vaultAddress = vault.vaultAddress || vault.address || "";
      const poolAddress = vault.pool?.poolAddress || vault.poolAddress;
      const feeTier = vault.pool?.feeTier || vault.fee || 0.3;

      // Extract APY data from various sources
      const apyData = vault.aprData || {};
      const apy =
        vault.apy ||
        vault.apr ||
        apyData.apr1dAvg ||
        apyData.apr7dAvg ||
        apyData.apr14dAvg ||
        0;

      const processedVault = {
        address: vaultAddress,
        name: vault.name || `Steer Vault ${vaultAddress?.slice(0, 8)}...`,
        chainId,
        token0: vault.token0 || "Unknown",
        token1: vault.token1 || "Unknown",
        fee: feeTier,
        tvl: vault.tvl || 0,
        volume24h: vault.volume24h || 0,
        apy: apy,
        isActive: vault.isActive !== false, // Default to true unless explicitly false
        createdAt: vault.createdAt || new Date().toISOString(),
        strategyType: vault.protocol || vault.strategyType || "Unknown",
        positions: vault.positions || [],
        poolAddress: poolAddress,
        ammType: vault.ammType || "UniswapV3",
        singleAssetDepositContract: vault.singleAssetDepositContract,
        // Additional fields from SDK
        protocol: vault.protocol,
        beaconName: vault.beaconName,
        protocolBaseType: vault.protocolBaseType,
        targetProtocol: vault.targetProtocol,
        // APY breakdown
        apr1d: apyData.apr1dAvg,
        apr7d: apyData.apr7dAvg,
        apr14d: apyData.apr14dAvg,
        // Fee breakdown
        feeApr: vault.feeApr,
        stakingApr: vault.stakingApr,
        merklApr: vault.merklApr,
      };

      // Try to get additional data from SDK if available
      try {
        const vaultDetails = await this.getVaultDetails(vaultAddress, chainId);
        if (vaultDetails) {
          // Update with real data if available
          if (vaultDetails.tvl) processedVault.tvl = vaultDetails.tvl;
          if (vaultDetails.volume24h)
            processedVault.volume24h = vaultDetails.volume24h;
          if (vaultDetails.apy) processedVault.apy = vaultDetails.apy;
          if (vaultDetails.apr) processedVault.apy = vaultDetails.apr;
        }

        // Try to get pool-specific data if we have a pool address
        if (poolAddress) {
          const poolData = await this.getPoolData(poolAddress, chainId);
          if (poolData) {
            // Update with pool data
            if (poolData.tvl) processedVault.tvl = poolData.tvl;
            if (poolData.volume24h)
              processedVault.volume24h = poolData.volume24h;
            if (poolData.fee) processedVault.fee = poolData.fee;
          }
        }

        // Try to get token price data for better TVL calculation
        try {
          const token0Address =
            typeof vault.token0 === "string"
              ? vault.token0
              : vault.token0?.address;
          const token1Address =
            typeof vault.token1 === "string"
              ? vault.token1
              : vault.token1?.address;

          if (token0Address && token1Address) {
            const priceData = await this.getTokenPrices(
              [token0Address, token1Address],
              chainId,
            );
            if (priceData && processedVault.tvl === 0) {
              // If we don't have TVL but have price data, we could calculate it
              logger.log(
                `Price data available for vault ${vaultAddress}: Token0: $${priceData[token0Address]}, Token1: $${priceData[token1Address]}`,
              );
            }
          }
        } catch (error) {
          logger.log(
            `Could not fetch price data for vault ${vaultAddress}:`,
            error,
          );
        }
      } catch (error) {
        logger.log(
          `Could not fetch additional data for vault ${vaultAddress}, using basic info`,
        );
      }

      // Enrich vault data with GraphQL information
      try {
        const enrichedVault = await this.enrichVaultWithGraphQLData(
          processedVault,
          chainId,
        );
        return enrichedVault;
      } catch (error) {
        logger.log(
          `Could not enrich vault ${vaultAddress} with GraphQL data, returning basic info:`,
          error,
        );
        return processedVault;
      }
    } catch (error) {
      logger.error(`Error processing vault ${vault.address}:`, error);
      return null;
    }
  }

  /**
   * Get vault details by address using GraphQL (preferred) or SDK fallback
   */
  async getVaultDetails(
    vaultAddress: string,
    chainId: number,
  ): Promise<any | null> {
    try {
      // First try to get data from GraphQL
      const graphqlData = await this.getVaultDataFromGraphQL(vaultAddress);
      if (graphqlData) {
        logger.log(`Found vault ${vaultAddress} via GraphQL`);
        return {
          address: vaultAddress,
          name: graphqlData.name,
          token0: graphqlData.token0,
          token1: graphqlData.token1,
          poolAddress: graphqlData.pool,
          weeklyFeeAPR: parseFloat(graphqlData.weeklyFeeAPR) || 0,
          token0Symbol: graphqlData.token0Symbol,
          token1Symbol: graphqlData.token1Symbol,
          token0Balance: graphqlData.token0Balance,
          token1Balance: graphqlData.token1Balance,
          totalLPTokensIssued: graphqlData.totalLPTokensIssued,
          feeTier: parseInt(graphqlData.feeTier) || 3000,
          fees0: graphqlData.fees0,
          fees1: graphqlData.fees1,
          strategyToken: graphqlData.strategyToken,
          beaconName: graphqlData.beaconName,
          deployer: graphqlData.deployer,
          chainId,
          // Calculate basic metrics
          tvl: this.calculateTvlFromBalances(
            graphqlData.token0Balance,
            graphqlData.token1Balance,
            parseInt(graphqlData.token0Decimals) || 18,
            parseInt(graphqlData.token1Decimals) || 18,
          ),
          apy: parseFloat(graphqlData.weeklyFeeAPR) * 52 || 0, // Convert weekly to annual
          isActive: true,
        };
      }

      // Fallback to SDK if GraphQL fails
      logger.log(
        `GraphQL data not available for ${vaultAddress}, falling back to SDK`,
      );
      return await this.getVaultDetailsFromSDK(vaultAddress, chainId);
    } catch (error) {
      logger.error(`Error getting vault details for ${vaultAddress}:`, error);
      return null;
    }
  }

  /**
   * Get vault details by address using SDK (fallback method)
   */
  private async getVaultDetailsFromSDK(
    vaultAddress: string,
    chainId: number,
  ): Promise<any | null> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        logger.warn(`No vault client available for chain ${chainId}`);
        return null;
      }

      // Get vault details using SDK - use getVaults and filter
      const vaultResponse = await vaultClient.getVaults({ chainId }, 100, null);

      if (!vaultResponse.success || !vaultResponse.data) {
        logger.warn(
          `Failed to get vault details for ${vaultAddress}: ${vaultResponse.error || "Unknown error"}`,
        );
        return null;
      }

      // Extract vaults from the paginated response structure
      const vaults =
        vaultResponse.data?.edges?.map((edge: any) => edge.node) || [];
      return vaults.length > 0 ? vaults[0] : null;
    } catch (error) {
      logger.error(
        `Error getting vault details for ${vaultAddress} on chain ${chainId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get token prices for TVL calculation
   */
  async getTokenPrices(
    tokenAddresses: string[],
    chainId: number,
  ): Promise<{ [address: string]: number } | null> {
    try {
      // This is a placeholder - in a real implementation, you'd call a price API
      // For now, we'll return null to indicate no price data
      logger.log(`Price fetching not yet implemented for chain ${chainId}`);
      return null;
    } catch (error) {
      logger.error(`Error getting token prices for chain ${chainId}:`, error);
      return null;
    }
  }

  /**
   * Get pool data including TVL, volume, and fee information
   */
  async getPoolData(poolAddress: string, chainId: number): Promise<any | null> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        logger.warn(`No vault client available for chain ${chainId}`);
        return null;
      }

      // Try to get pool information using the SDK
      try {
        const poolsResponse = await vaultClient.getPools(
          { chainId, protocol: "uniswap-v3" },
          100,
          null,
        );
        if (poolsResponse.success && poolsResponse.data) {
          const pools =
            poolsResponse.data.edges?.map((edge: any) => edge.node) || [];
          const matchingPool = pools.find(
            (pool: any) =>
              pool.poolAddress?.toLowerCase() === poolAddress.toLowerCase() ||
              pool.id?.toLowerCase() === poolAddress.toLowerCase(),
          );

          if (matchingPool) {
            return {
              tvl: matchingPool.totalValueLockedUSD
                ? parseFloat(matchingPool.totalValueLockedUSD)
                : 0,
              volume24h: matchingPool.volumeUSD
                ? parseFloat(matchingPool.volumeUSD)
                : 0,
              fee: matchingPool.feeTier
                ? parseFloat(matchingPool.feeTier) / 10000
                : 0.3, // Convert basis points to percentage
              liquidity: matchingPool.liquidity || 0,
            };
          }
        }
      } catch (error) {
        logger.log(
          `Could not fetch pool data from SDK for ${poolAddress}:`,
          error,
        );
      }

      // Fallback: return basic pool data
      return {
        tvl: 0,
        volume24h: 0,
        fee: 0.3,
        liquidity: 0,
      };
    } catch (error) {
      logger.error(
        `Error getting pool data for ${poolAddress} on chain ${chainId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get staking pool details by address using SDK
   */
  async getStakingPoolDetails(
    poolAddress: string,
    chainId: number,
  ): Promise<any | null> {
    try {
      const stakingClient = this.stakingClients.get(chainId);
      if (!stakingClient) {
        logger.warn(`No staking client available for chain ${chainId}`);
        return null;
      }

      // Get staking pool details using SDK
      const poolResponse = await stakingClient.getStakingPools({ chainId });

      if (!poolResponse.success || !poolResponse.data) {
        logger.warn(
          `Failed to get staking pool details for ${poolAddress}: ${poolResponse.error || "Unknown error"}`,
        );
        return null;
      }

      // Handle both array and paginated response structures
      const pools = Array.isArray(poolResponse.data)
        ? poolResponse.data
        : (poolResponse.data as any)?.edges?.map((edge: any) => edge.node) ||
          [];
      return pools.length > 0 ? pools[0] : null;
    } catch (error) {
      logger.error(
        `Error getting staking pool details for ${poolAddress} on chain ${chainId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Test GraphQL connection specifically
   */
  async testGraphQLConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.log("Testing GraphQL connection to Steer Protocol subgraph...");

      const query = `
                query TestConnection {
                    _meta {
                        block {
                            number
                        }
                    }
                }
            `;

      const response = await fetch(STEER_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText}`,
        );
      }

      const result = await response.json();

      if (result.data && result.data._meta) {
        logger.log("GraphQL connection test successful");
        return { success: true };
      } else {
        logger.warn("GraphQL response missing expected data structure");
        return { success: false, error: "Unexpected response structure" };
      }
    } catch (error) {
      logger.error("GraphQL connection test failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Test GraphQL vault query with a specific vault address
   */
  async testGraphQLVaultQuery(
    vaultAddress: string,
  ): Promise<{ success: boolean; data?: GraphQLVaultData; error?: string }> {
    try {
      logger.log(`Testing GraphQL vault query for: ${vaultAddress}`);

      const vaultData = await this.getVaultDataFromGraphQL(vaultAddress);

      if (vaultData) {
        logger.log(`GraphQL vault query successful for ${vaultAddress}`);
        return { success: true, data: vaultData };
      } else {
        logger.warn(`No vault data found for ${vaultAddress}`);
        return { success: false, error: "Vault not found" };
      }
    } catch (error) {
      logger.error(
        `GraphQL vault query test failed for ${vaultAddress}:`,
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Test connection to Steer Finance services using SDK
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      logger.log("Testing Steer Finance connection using SDK...");

      let totalVaultCount = 0;
      let totalStakingPoolCount = 0;
      const connectionErrors: string[] = [];

      // Test SDK connection for each chain
      for (const chainId of this.supportedChains) {
        try {
          logger.log(`Testing connection for chain ${chainId}...`);

          // Test vault client
          const vaultClient = this.vaultClients.get(chainId);
          if (vaultClient) {
            const vaultsResponse = await vaultClient.getVaults(
              { chainId },
              100,
              null,
            );
            logger.log(`Chain ${chainId} vault response:`, {
              success: vaultsResponse.success,
              hasData: !!vaultsResponse.data,
              dataType: typeof vaultsResponse.data,
              isArray: Array.isArray(vaultsResponse.data),
              hasEdges: !!vaultsResponse.data?.edges,
              edgesLength: vaultsResponse.data?.edges?.length || 0,
            });

            if (vaultsResponse.success && vaultsResponse.data) {
              const vaults =
                vaultsResponse.data.edges?.map((edge: any) => edge.node) || [];
              totalVaultCount += vaults.length;
              logger.log(`Chain ${chainId}: Found ${vaults.length} vaults`);
            }
          }

          // Test staking client
          const stakingClient = this.stakingClients.get(chainId);
          if (stakingClient) {
            const poolsResponse = await stakingClient.getStakingPools({
              chainId,
            });
            if (poolsResponse.success && poolsResponse.data) {
              // Handle both array and paginated response structures
              const pools = Array.isArray(poolsResponse.data)
                ? poolsResponse.data
                : (poolsResponse.data as any)?.edges?.map(
                    (edge: any) => edge.node,
                  ) || [];
              totalStakingPoolCount += pools.length;
              logger.log(
                `Chain ${chainId}: Found ${pools.length} staking pools`,
              );
            }
          }
        } catch (error) {
          const errorMsg = `Chain ${chainId}: ${error instanceof Error ? error.message : "Unknown error"}`;
          connectionErrors.push(errorMsg);
          logger.error(`Connection test failed for chain ${chainId}:`, error);
        }
      }

      const result: ConnectionTestResult = {
        connectionTest: connectionErrors.length === 0,
        supportedChains: this.supportedChains,
        vaultCount: totalVaultCount,
        stakingPoolCount: totalStakingPoolCount,
        error:
          connectionErrors.length > 0 ? connectionErrors.join("; ") : undefined,
      };

      logger.log(
        `Steer connection test completed. Vaults: ${totalVaultCount}, Staking Pools: ${totalStakingPoolCount}`,
      );
      return result;
    } catch (error) {
      logger.error("Error testing Steer connection:", error);
      return {
        connectionTest: false,
        supportedChains: this.supportedChains,
        vaultCount: 0,
        stakingPoolCount: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Normalize token identifier (handle different formats)
   */
  private normalizeTokenIdentifier(tokenIdentifier: string): string {
    // Remove common prefixes and normalize
    let normalized = tokenIdentifier.trim();

    // Handle Solana-style addresses (base58)
    if (
      normalized.length === 44 &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(normalized)
    ) {
      // This is likely a Solana address, but Steer is EVM-based
      logger.warn(
        `Token ${normalized} appears to be a Solana address, but Steer Finance is EVM-based`,
      );
    }

    // Handle Ethereum-style addresses (0x...)
    if (normalized.startsWith("0x")) {
      return normalized.toLowerCase();
    }

    // For symbol-based lookups, return as-is (no hardcoded mapping)
    return normalized;
  }

  /**
   * Get token name from identifier
   */
  private getTokenName(tokenIdentifier: string): string {
    // For token addresses, return a formatted version
    if (tokenIdentifier.startsWith("0x")) {
      return `Token ${tokenIdentifier.slice(0, 8)}...${tokenIdentifier.slice(-6)}`;
    }

    // For symbols or other identifiers, return as-is
    return tokenIdentifier;
  }

  /**
   * Get chain name from chain ID
   */
  private getChainName(chainId: number): string {
    const chainNames: { [key: number]: string } = {
      1: "Ethereum Mainnet",
      137: "Polygon",
      42161: "Arbitrum One",
      10: "Optimism",
      8453: "Base",
    };
    return chainNames[chainId] || `Chain ${chainId}`;
  }

  /**
   * Get data from cache if it's still valid
   */
  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  /**
   * Set data in cache with timestamp
   */
  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Clear expired cache entries
   */
  private clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }

  // Service lifecycle methods

  static async create(runtime: IAgentRuntime): Promise<SteerLiquidityService> {
    return new SteerLiquidityService(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<SteerLiquidityService> {
    const service = new SteerLiquidityService(runtime);
    await service.start();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(
      "STEER_LIQUIDITY_SERVICE",
    ) as unknown as SteerLiquidityService;
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("SteerLiquidityService is already running");
      return;
    }

    try {
      // Clear any expired cache entries
      this.clearExpiredCache();

      this.isRunning = true;
      logger.log("SteerLiquidityService started successfully");
    } catch (error) {
      logger.error("Failed to start SteerLiquidityService:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("SteerLiquidityService is not running");
      return;
    }

    try {
      this.isRunning = false;
      logger.log("SteerLiquidityService stopped successfully");
    } catch (error) {
      logger.error("Failed to stop SteerLiquidityService:", error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Preview single-asset deposit for a vault using SDK
   */
  async previewSingleAssetDeposit(
    vaultAddress: string,
    chainId: number,
    assets: bigint,
    isToken0: boolean,
    depositSlippagePercent: bigint = 5n,
    swapSlippageBP: number = 500,
  ): Promise<any> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        throw new Error(`No vault client available for chain ${chainId}`);
      }

      // Get vault details to get the pool address and single asset deposit contract
      const vault = await this.getVaultDetails(vaultAddress, chainId);
      if (!vault) {
        throw new Error(`Vault ${vaultAddress} not found on chain ${chainId}`);
      }

      if (!vault.poolAddress || !vault.singleAssetDepositContract) {
        throw new Error(
          `Vault ${vaultAddress} does not support single-asset deposits`,
        );
      }

      // Preview the single-asset deposit using SDK
      const preview = await vaultClient.previewSingleAssetDeposit(
        {
          assets,
          receiver:
            "0x0000000000000000000000000000000000000000" as `0x${string}`, // Placeholder
          vault: vaultAddress as `0x${string}`,
          isToken0,
          depositSlippagePercent,
          swapSlippageBP,
          ammType: AMMType.UniswapV3,
          singleAssetDepositContract: vault.singleAssetDepositContract,
        },
        vault.poolAddress,
      );

      return preview;
    } catch (error) {
      logger.error(
        `Error previewing single-asset deposit for vault ${vaultAddress}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Execute single-asset deposit for a vault using SDK
   */
  async executeSingleAssetDeposit(
    vaultAddress: string,
    chainId: number,
    assets: bigint,
    receiver: string,
    isToken0: boolean,
    depositSlippagePercent: bigint = 5n,
    swapSlippageBP: number = 500,
  ): Promise<any> {
    try {
      const vaultClient = this.vaultClients.get(chainId);
      if (!vaultClient) {
        throw new Error(`No vault client available for chain ${chainId}`);
      }

      // Get vault details to get the single asset deposit contract
      const vault = await this.getVaultDetails(vaultAddress, chainId);
      if (!vault) {
        throw new Error(`Vault ${vaultAddress} not found on chain ${chainId}`);
      }

      if (!vault.singleAssetDepositContract) {
        throw new Error(
          `Vault ${vaultAddress} does not support single-asset deposits`,
        );
      }

      // Execute the single-asset deposit using SDK
      const result = await vaultClient.singleAssetDeposit({
        assets,
        receiver: receiver as `0x${string}`,
        vault: vaultAddress as `0x${string}`,
        isToken0,
        depositSlippagePercent,
        swapSlippageBP,
        ammType: AMMType.UniswapV3,
        singleAssetDepositContract: vault.singleAssetDepositContract,
      });

      return result;
    } catch (error) {
      logger.error(
        `Error executing single-asset deposit for vault ${vaultAddress}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get earned rewards for a staking pool using SDK
   */
  async getEarnedRewards(
    poolAddress: string,
    accountAddress: string,
    chainId: number,
  ): Promise<any> {
    try {
      const stakingClient = this.stakingClients.get(chainId);
      if (!stakingClient) {
        throw new Error(`No staking client available for chain ${chainId}`);
      }

      const earned = await stakingClient.earned(
        poolAddress as `0x${string}`,
        accountAddress as `0x${string}`,
      );
      return earned;
    } catch (error) {
      logger.error(
        `Error getting earned rewards for pool ${poolAddress}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get total supply of a staking pool using SDK
   */
  async getStakingPoolTotalSupply(
    poolAddress: string,
    chainId: number,
  ): Promise<any> {
    try {
      const stakingClient = this.stakingClients.get(chainId);
      if (!stakingClient) {
        throw new Error(`No staking client available for chain ${chainId}`);
      }

      const totalSupply = await stakingClient.totalSupply(
        poolAddress as `0x${string}`,
      );
      return totalSupply;
    } catch (error) {
      logger.error(
        `Error getting total supply for pool ${poolAddress}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get balance of a user in a staking pool using SDK
   */
  async getStakingPoolBalance(
    poolAddress: string,
    accountAddress: string,
    chainId: number,
  ): Promise<any> {
    try {
      const stakingClient = this.stakingClients.get(chainId);
      if (!stakingClient) {
        throw new Error(`No staking client available for chain ${chainId}`);
      }

      const balance = await stakingClient.balanceOf(
        poolAddress as `0x${string}`,
        accountAddress as `0x${string}`,
      );
      return balance;
    } catch (error) {
      logger.error(`Error getting balance for pool ${poolAddress}:`, error);
      throw error;
    }
  }

  /**
   * Fetch detailed vault data from Steer Protocol GraphQL subgraph
   */
  async getVaultDataFromGraphQL(
    vaultAddress: string,
  ): Promise<GraphQLVaultData | null> {
    try {
      logger.log(`Fetching GraphQL data for vault: ${vaultAddress}`);

      const query = `
                query GetVault($vaultId: ID!) {
                    vault(id: $vaultId) {
                        id
                        name
                        token0
                        token1
                        pool
                        weeklyFeeAPR
                        token0Symbol
                        token0Decimals
                        token1Symbol
                        token1Decimals
                        token0Balance
                        token1Balance
                        totalLPTokensIssued
                        feeTier
                        fees0
                        fees1
                        strategyToken {
                            id
                            name
                            creator {
                                id
                            }
                            admin
                            executionBundle
                        }
                        beaconName
                        payloadIpfs
                        deployer
                    }
                }
            `;

      const variables = {
        vaultId: vaultAddress.toLowerCase(),
      };

      const response = await fetch(STEER_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText}`,
        );
      }

      const result: GraphQLResponse = await response.json();

      if (result.data && result.data.vault) {
        logger.log(
          `Successfully fetched GraphQL data for vault ${vaultAddress}`,
        );
        logger.log(`GraphQL vault data:`, {
          name: result.data.vault.name,
          token0Symbol: result.data.vault.token0Symbol,
          token1Symbol: result.data.vault.token1Symbol,
          weeklyFeeAPR: result.data.vault.weeklyFeeAPR,
          token0Balance: result.data.vault.token0Balance,
          token1Balance: result.data.vault.token1Balance,
        });
        return result.data.vault;
      } else {
        logger.warn(
          `No vault data found in GraphQL response for ${vaultAddress}`,
        );
        logger.log(`GraphQL response:`, JSON.stringify(result, null, 2));
        return null;
      }
    } catch (error) {
      logger.error(
        `Error fetching GraphQL data for vault ${vaultAddress}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Enrich vault data with GraphQL information
   */
  async enrichVaultWithGraphQLData(vault: any, chainId: number): Promise<any> {
    try {
      if (!vault.address && !vault.vaultAddress) {
        logger.warn("Vault missing address, cannot fetch GraphQL data");
        return vault;
      }

      const vaultAddress = vault.address || vault.vaultAddress;
      logger.log(`Enriching vault ${vaultAddress} with GraphQL data...`);

      // Fetch GraphQL data
      const graphqlData = await this.getVaultDataFromGraphQL(vaultAddress);

      if (graphqlData) {
        // Merge GraphQL data with existing vault data
        const enrichedVault = {
          ...vault,
          // GraphQL specific fields
          graphqlData: {
            weeklyFeeAPR: parseFloat(graphqlData.weeklyFeeAPR) || 0,
            token0Symbol: graphqlData.token0Symbol,
            token0Decimals: parseInt(graphqlData.token0Decimals) || 18,
            token1Symbol: graphqlData.token1Symbol,
            token1Decimals: parseInt(graphqlData.token1Decimals) || 18,
            token0Balance: graphqlData.token0Balance,
            token1Balance: graphqlData.token1Balance,
            totalLPTokensIssued: graphqlData.totalLPTokensIssued,
            feeTier: parseInt(graphqlData.feeTier) || 3000,
            fees0: graphqlData.fees0,
            fees1: graphqlData.fees1,
            strategyToken: graphqlData.strategyToken,
            beaconName: graphqlData.beaconName,
            payloadIpfs: graphqlData.payloadIpfs,
            deployer: graphqlData.deployer,
          },
          // Update existing fields with GraphQL data if available
          name: graphqlData.name || vault.name,
          token0: graphqlData.token0 || vault.token0,
          token1: graphqlData.token1 || vault.token1,
          poolAddress: graphqlData.pool || vault.poolAddress,
          // Update TVL with GraphQL data if available
          tvl:
            vault.tvl ||
            this.calculateTvlFromBalances(
              graphqlData.token0Balance,
              graphqlData.token1Balance,
              parseInt(graphqlData.token0Decimals) || 18,
              parseInt(graphqlData.token1Decimals) || 18,
            ),
          // Calculate TVL from token balances if not available
          calculatedTvl: this.calculateTvlFromBalances(
            graphqlData.token0Balance,
            graphqlData.token1Balance,
            parseInt(graphqlData.token0Decimals) || 18,
            parseInt(graphqlData.token1Decimals) || 18,
          ),
        };

        logger.log(
          `Successfully enriched vault ${vaultAddress} with GraphQL data`,
        );
        return enrichedVault;
      }

      logger.log(
        `No GraphQL data available for vault ${vaultAddress}, returning original data`,
      );
      return vault;
    } catch (error) {
      logger.error(`Error enriching vault with GraphQL data:`, error);
      return vault; // Return original vault data if enrichment fails
    }
  }

  /**
   * Calculate TVL from token balances using LP tokens as proxy
   */
  private calculateTvlFromBalances(
    token0Balance: string,
    token1Balance: string,
    token0Decimals: number,
    token1Decimals: number,
  ): number {
    try {
      // Convert string balances to numbers with proper decimals
      const token0Amount =
        parseFloat(token0Balance) / Math.pow(10, token0Decimals);
      const token1Amount =
        parseFloat(token1Balance) / Math.pow(10, token1Decimals);

      logger.log(
        `Token balances - Token0: ${token0Amount}, Token1: ${token1Amount}`,
      );

      // Use a simple estimation: assume average token price of $1
      // This is a rough approximation - in production you'd fetch real prices
      const estimatedTvl = (token0Amount + token1Amount) * 1;

      logger.log(`Estimated TVL: $${estimatedTvl.toLocaleString()}`);
      return estimatedTvl;
    } catch (error) {
      logger.error("Error calculating TVL from balances:", error);
      return 0;
    }
  }
}
