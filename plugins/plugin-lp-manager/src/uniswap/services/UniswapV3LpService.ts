import { Service, IAgentRuntime, logger } from '@elizaos/core';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Chain,
  parseUnits,
  formatUnits,
  maxUint128,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as viemChains from 'viem/chains';
import type {
  EvmDex,
  EvmPoolInfo,
  EvmPositionDetails,
  EvmAddLiquidityParams,
  EvmRemoveLiquidityParams,
  EvmTransactionResult,
  IEvmLpService,
} from '../../types.ts';
import {
  UNISWAP_V3_ADDRESSES,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  UNISWAP_V3_POSITION_MANAGER_ABI,
  ERC20_ABI,
  UNISWAP_V3_FEE_TIERS,
  type UniswapV3FeeTier,
  type UniswapV3Position,
} from '../types.ts';

const SUPPORTED_CHAIN_IDS = [1, 8453, 42161, 137, 10]; // Ethereum, Base, Arbitrum, Polygon, Optimism

function getViemChain(chainId: number): Chain {
  const chainMap: Record<number, Chain> = {
    1: viemChains.mainnet,
    8453: viemChains.base,
    42161: viemChains.arbitrum,
    137: viemChains.polygon,
    10: viemChains.optimism,
  };
  const chain = chainMap[chainId];
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return chain;
}

export class UniswapV3LpService extends Service implements IEvmLpService {
  public static readonly serviceType = 'uniswap-v3-lp';
  public readonly capabilityDescription = 'Provides Uniswap V3 liquidity pool management for EVM chains.';

  private publicClients: Map<number, PublicClient> = new Map();
  private walletClients: Map<number, WalletClient> = new Map();
  private rpcUrls: Map<number, string> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.initializeRpcUrls();
    }
  }

  private initializeRpcUrls(): void {
    // Try to get RPC URLs from settings
    const rpcSettings: Record<number, string[]> = {
      1: ['ETHEREUM_RPC_URL', 'ETH_RPC_URL', 'EVM_PROVIDER_MAINNET'],
      8453: ['BASE_RPC_URL', 'EVM_PROVIDER_BASE'],
      42161: ['ARBITRUM_RPC_URL', 'EVM_PROVIDER_ARBITRUM'],
      137: ['POLYGON_RPC_URL', 'EVM_PROVIDER_POLYGON'],
      10: ['OPTIMISM_RPC_URL', 'EVM_PROVIDER_OPTIMISM'],
    };

    for (const [chainId, envKeys] of Object.entries(rpcSettings)) {
      for (const key of envKeys) {
        const rpcUrl = this.runtime.getSetting(key);
        if (rpcUrl && typeof rpcUrl === 'string') {
          this.rpcUrls.set(Number(chainId), rpcUrl);
          break;
        }
      }
    }
  }

  private getPublicClient(chainId: number): PublicClient {
    let client = this.publicClients.get(chainId);
    if (client) return client;

    const rpcUrl = this.rpcUrls.get(chainId);
    const chain = getViemChain(chainId);

    client = createPublicClient({
      chain,
      transport: rpcUrl ? http(rpcUrl) : http(),
    });

    this.publicClients.set(chainId, client);
    return client;
  }

  private getWalletClient(chainId: number, privateKey: `0x${string}`): WalletClient {
    const cacheKey = chainId;
    let client = this.walletClients.get(cacheKey);
    if (client) return client;

    const rpcUrl = this.rpcUrls.get(chainId);
    const chain = getViemChain(chainId);
    const account = privateKeyToAccount(privateKey);

    client = createWalletClient({
      chain,
      transport: rpcUrl ? http(rpcUrl) : http(),
      account,
    });

    this.walletClients.set(cacheKey, client);
    return client;
  }

  static async start(runtime: IAgentRuntime): Promise<UniswapV3LpService> {
    const service = new UniswapV3LpService(runtime);
    logger.info('[UniswapV3LpService] started');
    return service;
  }

  async stop(): Promise<void> {
    this.publicClients.clear();
    this.walletClients.clear();
    logger.info('[UniswapV3LpService] stopped');
  }

  getDexName(): EvmDex {
    return 'uniswap';
  }

  getSupportedChainIds(): number[] {
    return SUPPORTED_CHAIN_IDS.filter(chainId => 
      UNISWAP_V3_ADDRESSES[chainId] !== undefined
    );
  }

  supportsChain(chainId: number): boolean {
    return this.getSupportedChainIds().includes(chainId);
  }

  async getPools(
    chainId: number,
    tokenA?: Address,
    tokenB?: Address,
    feeTier?: number
  ): Promise<EvmPoolInfo[]> {
    if (!this.supportsChain(chainId)) {
      logger.warn(`[UniswapV3LpService] Chain ${chainId} not supported`);
      return [];
    }

    const addresses = UNISWAP_V3_ADDRESSES[chainId];
    if (!addresses) return [];

    const client = this.getPublicClient(chainId);
    const pools: EvmPoolInfo[] = [];

    // If specific tokens are provided, look up their pools
    if (tokenA && tokenB) {
      const feeTiers = feeTier 
        ? [feeTier as UniswapV3FeeTier] 
        : Object.values(UNISWAP_V3_FEE_TIERS);

      for (const fee of feeTiers) {
        try {
          const poolAddress = await client.readContract({
            address: addresses.factory,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: 'getPool',
            args: [tokenA, tokenB, fee],
          });

          if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
            const poolInfo = await this.getPoolInfo(chainId, poolAddress as Address);
            if (poolInfo) {
              pools.push(poolInfo);
            }
          }
        } catch (error: unknown) {
          logger.debug(`[UniswapV3LpService] No pool found for ${tokenA}/${tokenB} at fee ${fee}`);
        }
      }
    }

    return pools;
  }

  private async getPoolInfo(chainId: number, poolAddress: Address): Promise<EvmPoolInfo | null> {
    const client = this.getPublicClient(chainId);
    const chain = getViemChain(chainId);

    try {
      const [token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' }),
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token1' }),
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'fee' }),
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'tickSpacing' }),
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'liquidity' }),
        client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' }),
      ]);

      // Get token info
      const [symbol0, decimals0, symbol1, decimals1] = await Promise.all([
        client.readContract({ address: token0 as Address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: token0 as Address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
        client.readContract({ address: token1 as Address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: token1 as Address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ]);

      const poolInfo: EvmPoolInfo = {
        id: poolAddress,
        dex: 'uniswap',
        chainId,
        chainName: chain.name,
        poolAddress,
        tokenA: {
          address: token0 as Address,
          symbol: symbol0 as string,
          decimals: Number(decimals0),
        },
        tokenB: {
          address: token1 as Address,
          symbol: symbol1 as string,
          decimals: Number(decimals1),
        },
        feeTier: Number(fee),
        tickSpacing: Number(tickSpacing),
        currentTick: Number(slot0[1]),
        sqrtPriceX96: slot0[0] as bigint,
        fee: Number(fee) / 1_000_000, // Convert to percentage
        displayName: `${symbol0}/${symbol1} (${Number(fee) / 10000}%)`,
      };

      return poolInfo;
    } catch (error: unknown) {
      logger.error(`[UniswapV3LpService] Error fetching pool info for ${poolAddress}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async addLiquidity(params: EvmAddLiquidityParams): Promise<EvmTransactionResult> {
    if (!this.supportsChain(params.chainId)) {
      return { success: false, error: `Chain ${params.chainId} not supported` };
    }

    const addresses = UNISWAP_V3_ADDRESSES[params.chainId];
    if (!addresses) {
      return { success: false, error: 'Uniswap V3 not deployed on this chain' };
    }

    try {
      const publicClient = this.getPublicClient(params.chainId);
      const walletClient = this.getWalletClient(params.chainId, params.wallet.privateKey);

      // Get pool info
      const poolInfo = await this.getPoolInfo(params.chainId, params.poolAddress);
      if (!poolInfo) {
        return { success: false, error: 'Pool not found' };
      }

      // Calculate min amounts with slippage
      const slippageMultiplier = BigInt(10000 - params.slippageBps);
      const amount0Min = (params.tokenAAmount * slippageMultiplier) / 10000n;
      const amount1Min = (params.tokenBAmount ?? 0n) * slippageMultiplier / 10000n;

      // Approve tokens if needed
      await this.approveToken(
        params.chainId,
        params.wallet.privateKey,
        poolInfo.tokenA.address,
        addresses.nonfungiblePositionManager,
        params.tokenAAmount
      );

      if (params.tokenBAmount && params.tokenBAmount > 0n) {
        await this.approveToken(
          params.chainId,
          params.wallet.privateKey,
          poolInfo.tokenB.address,
          addresses.nonfungiblePositionManager,
          params.tokenBAmount
        );
      }

      const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min default

      // Determine tick range
      const tickLower = params.tickLower ?? (poolInfo.currentTick! - 1000);
      const tickUpper = params.tickUpper ?? (poolInfo.currentTick! + 1000);

      // Align ticks to tick spacing
      const tickSpacing = poolInfo.tickSpacing ?? 60;
      const alignedTickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
      const alignedTickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;

      const mintParams = {
        token0: poolInfo.tokenA.address,
        token1: poolInfo.tokenB.address,
        fee: poolInfo.feeTier!,
        tickLower: alignedTickLower,
        tickUpper: alignedTickUpper,
        amount0Desired: params.tokenAAmount,
        amount1Desired: params.tokenBAmount ?? 0n,
        amount0Min,
        amount1Min,
        recipient: params.wallet.address,
        deadline,
      };

      const { request } = await publicClient.simulateContract({
        address: addresses.nonfungiblePositionManager,
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'mint',
        args: [mintParams],
        account: walletClient.account,
      });

      const hash = await walletClient.writeContract(request);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        success: receipt.status === 'success',
        transactionId: hash,
        hash,
        chainId: params.chainId,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        data: {
          poolAddress: params.poolAddress,
          tickLower: alignedTickLower,
          tickUpper: alignedTickUpper,
        },
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[UniswapV3LpService] Error adding liquidity:', errorMsg);
      return {
        success: false,
        error: errorMsg || 'Unknown error adding liquidity',
      };
    }
  }

  async removeLiquidity(params: EvmRemoveLiquidityParams): Promise<EvmTransactionResult> {
    if (!this.supportsChain(params.chainId)) {
      return { success: false, error: `Chain ${params.chainId} not supported` };
    }

    const addresses = UNISWAP_V3_ADDRESSES[params.chainId];
    if (!addresses) {
      return { success: false, error: 'Uniswap V3 not deployed on this chain' };
    }

    if (!params.tokenId) {
      return { success: false, error: 'Position token ID required for Uniswap V3' };
    }

    try {
      const publicClient = this.getPublicClient(params.chainId);
      const walletClient = this.getWalletClient(params.chainId, params.wallet.privateKey);

      // Get position info
      const position = await this.getPositionFromContract(params.chainId, params.tokenId);
      if (!position) {
        return { success: false, error: 'Position not found' };
      }

      // Calculate liquidity to remove
      let liquidityToRemove = position.liquidity;
      if (params.percentageToRemove && params.percentageToRemove < 100) {
        liquidityToRemove = (position.liquidity * BigInt(params.percentageToRemove)) / 100n;
      }

      const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);
      const slippageMultiplier = BigInt(10000 - params.slippageBps);

      // First, decrease liquidity
      const decreaseParams = {
        tokenId: params.tokenId,
        liquidity: liquidityToRemove,
        amount0Min: 0n, // Will be calculated based on actual amounts
        amount1Min: 0n,
        deadline,
      };

      const { request: decreaseRequest } = await publicClient.simulateContract({
        address: addresses.nonfungiblePositionManager,
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [decreaseParams],
        account: walletClient.account,
      });

      const decreaseHash = await walletClient.writeContract(decreaseRequest);
      await publicClient.waitForTransactionReceipt({ hash: decreaseHash });

      // Then collect the tokens
      const collectParams = {
        tokenId: params.tokenId,
        recipient: params.wallet.address,
        amount0Max: maxUint128,
        amount1Max: maxUint128,
      };

      const { request: collectRequest } = await publicClient.simulateContract({
        address: addresses.nonfungiblePositionManager,
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'collect',
        args: [collectParams],
        account: walletClient.account,
      });

      const collectHash = await walletClient.writeContract(collectRequest);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: collectHash });

      // If removing all liquidity, burn the NFT
      if (params.percentageToRemove === 100 || !params.percentageToRemove) {
        try {
          const { request: burnRequest } = await publicClient.simulateContract({
            address: addresses.nonfungiblePositionManager,
            abi: UNISWAP_V3_POSITION_MANAGER_ABI,
            functionName: 'burn',
            args: [params.tokenId],
            account: walletClient.account,
          });
          await walletClient.writeContract(burnRequest);
        } catch (burnError: unknown) {
          logger.debug('[UniswapV3LpService] Could not burn position NFT:', burnError instanceof Error ? burnError.message : String(burnError));
        }
      }

      return {
        success: receipt.status === 'success',
        transactionId: collectHash,
        hash: collectHash,
        chainId: params.chainId,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[UniswapV3LpService] Error removing liquidity:', errorMsg);
      return {
        success: false,
        error: errorMsg || 'Unknown error removing liquidity',
      };
    }
  }

  private async getPositionFromContract(chainId: number, tokenId: bigint): Promise<UniswapV3Position | null> {
    const addresses = UNISWAP_V3_ADDRESSES[chainId];
    if (!addresses) return null;

    const client = this.getPublicClient(chainId);

    try {
      const result = await client.readContract({
        address: addresses.nonfungiblePositionManager,
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [tokenId],
      });

      return {
        tokenId,
        nonce: result[0],
        operator: result[1] as Address,
        token0: result[2] as Address,
        token1: result[3] as Address,
        fee: result[4] as UniswapV3FeeTier,
        tickLower: result[5],
        tickUpper: result[6],
        liquidity: result[7],
        feeGrowthInside0LastX128: result[8],
        feeGrowthInside1LastX128: result[9],
        tokensOwed0: result[10],
        tokensOwed1: result[11],
      };
    } catch (error: unknown) {
      logger.error(`[UniswapV3LpService] Error fetching position ${tokenId}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async getPositionDetails(
    chainId: number,
    owner: Address,
    poolAddress: Address,
    tokenId?: bigint
  ): Promise<EvmPositionDetails | null> {
    if (!this.supportsChain(chainId)) return null;

    // If we have a token ID, get that specific position
    if (tokenId) {
      const position = await this.getPositionFromContract(chainId, tokenId);
      if (!position) return null;

      const client = this.getPublicClient(chainId);
      const chain = getViemChain(chainId);

      // Get token info
      const [symbol0, decimals0, symbol1, decimals1] = await Promise.all([
        client.readContract({ address: position.token0, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: position.token0, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
        client.readContract({ address: position.token1, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: position.token1, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ]);

      return {
        poolId: poolAddress,
        dex: 'uniswap',
        chainId,
        owner,
        tokenId: position.tokenId,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
        lpTokenBalance: {
          address: poolAddress,
          balance: position.liquidity.toString(),
          decimals: 0,
          symbol: `UNI-V3-${symbol0}/${symbol1}`,
        },
        underlyingTokens: [
          {
            address: position.token0,
            balance: position.tokensOwed0.toString(),
            decimals: Number(decimals0),
            symbol: symbol0 as string,
          },
          {
            address: position.token1,
            balance: position.tokensOwed1.toString(),
            decimals: Number(decimals1),
            symbol: symbol1 as string,
          },
        ],
      };
    }

    // Otherwise, find positions for this owner in this pool
    const positions = await this.getAllPositions(chainId, owner);
    return positions.find(p => p.poolId.toLowerCase() === poolAddress.toLowerCase()) ?? null;
  }

  async getAllPositions(chainId: number, owner: Address): Promise<EvmPositionDetails[]> {
    if (!this.supportsChain(chainId)) return [];

    const addresses = UNISWAP_V3_ADDRESSES[chainId];
    if (!addresses) return [];

    const client = this.getPublicClient(chainId);
    const positions: EvmPositionDetails[] = [];

    try {
      const balance = await client.readContract({
        address: addresses.nonfungiblePositionManager,
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });

      for (let i = 0; i < Number(balance); i++) {
        const tokenId = await client.readContract({
          address: addresses.nonfungiblePositionManager,
          abi: UNISWAP_V3_POSITION_MANAGER_ABI,
          functionName: 'tokenOfOwnerByIndex',
          args: [owner, BigInt(i)],
        });

        const position = await this.getPositionFromContract(chainId, tokenId as bigint);
        if (position && position.liquidity > 0n) {
          // Find the pool address
          const poolAddress = await client.readContract({
            address: addresses.factory,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: 'getPool',
            args: [position.token0, position.token1, position.fee],
          });

          if (poolAddress) {
            const details = await this.getPositionDetails(
              chainId,
              owner,
              poolAddress as Address,
              tokenId as bigint
            );
            if (details) {
              positions.push(details);
            }
          }
        }
      }
    } catch (error: unknown) {
      logger.error('[UniswapV3LpService] Error fetching all positions:', error instanceof Error ? error.message : String(error));
    }

    return positions;
  }

  async getMarketData(poolAddresses: Address[]): Promise<Record<string, Partial<EvmPoolInfo>>> {
    const result: Record<string, Partial<EvmPoolInfo>> = {};

    for (const address of poolAddresses) {
      // Try each supported chain
      for (const chainId of this.getSupportedChainIds()) {
        try {
          const poolInfo = await this.getPoolInfo(chainId, address);
          if (poolInfo) {
            result[address] = poolInfo;
            break;
          }
        } catch {
          // Pool not on this chain
        }
      }
    }

    return result;
  }

  private async approveToken(
    chainId: number,
    privateKey: `0x${string}`,
    tokenAddress: Address,
    spenderAddress: Address,
    amount: bigint
  ): Promise<void> {
    const publicClient = this.getPublicClient(chainId);
    const walletClient = this.getWalletClient(chainId, privateKey);

    // Check current allowance
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account!.address, spenderAddress],
    });

    if ((allowance as bigint) >= amount) {
      return;
    }

    logger.info(`[UniswapV3LpService] Approving ${tokenAddress} for ${spenderAddress}`);

    const { request } = await publicClient.simulateContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spenderAddress, amount],
      account: walletClient.account,
    });

    const hash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });

    logger.info(`[UniswapV3LpService] Token approved: ${hash}`);
  }
}
