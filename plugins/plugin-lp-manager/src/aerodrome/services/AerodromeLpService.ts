import { Service, IAgentRuntime, logger } from '@elizaos/core';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
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
  AERODROME_ADDRESSES,
  AERODROME_ROUTER_ABI,
  AERODROME_FACTORY_ABI,
  AERODROME_POOL_ABI,
  ERC20_ABI,
  type AerodromePoolType,
} from '../types.ts';

const SUPPORTED_CHAIN_IDS = [8453]; // Base only

export class AerodromeLpService extends Service implements IEvmLpService {
  public static readonly serviceType = 'aerodrome-lp';
  public readonly capabilityDescription = 'Provides Aerodrome DEX liquidity pool management on Base chain.';

  private publicClient: PublicClient | null = null;
  private walletClients: Map<string, WalletClient> = new Map();
  private rpcUrl: string | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.initializeRpcUrl();
    }
  }

  private initializeRpcUrl(): void {
    const envKeys = ['BASE_RPC_URL', 'EVM_PROVIDER_BASE'];
    for (const key of envKeys) {
      const rpcUrl = this.runtime.getSetting(key);
      if (rpcUrl && typeof rpcUrl === 'string') {
        this.rpcUrl = rpcUrl;
        break;
      }
    }
  }

  private getPublicClient(): PublicClient {
    if (this.publicClient) return this.publicClient;

    this.publicClient = createPublicClient({
      chain: base,
      transport: this.rpcUrl ? http(this.rpcUrl) : http(),
    });

    return this.publicClient;
  }

  private getWalletClient(privateKey: `0x${string}`): WalletClient {
    const cacheKey = privateKey.slice(0, 10);
    let client = this.walletClients.get(cacheKey);
    if (client) return client;

    const account = privateKeyToAccount(privateKey);

    client = createWalletClient({
      chain: base,
      transport: this.rpcUrl ? http(this.rpcUrl) : http(),
      account,
    });

    this.walletClients.set(cacheKey, client);
    return client;
  }

  static async start(runtime: IAgentRuntime): Promise<AerodromeLpService> {
    const service = new AerodromeLpService(runtime);
    logger.info('[AerodromeLpService] started');
    return service;
  }

  async stop(): Promise<void> {
    this.publicClient = null;
    this.walletClients.clear();
    logger.info('[AerodromeLpService] stopped');
  }

  getDexName(): EvmDex {
    return 'aerodrome';
  }

  getSupportedChainIds(): number[] {
    return SUPPORTED_CHAIN_IDS;
  }

  supportsChain(chainId: number): boolean {
    return chainId === 8453;
  }

  async getPools(
    chainId: number,
    tokenA?: Address,
    tokenB?: Address,
    feeTier?: number // Ignored for Aerodrome - uses stable/volatile instead
  ): Promise<EvmPoolInfo[]> {
    if (!this.supportsChain(chainId)) {
      logger.warn(`[AerodromeLpService] Chain ${chainId} not supported`);
      return [];
    }

    const addresses = AERODROME_ADDRESSES[8453];
    const client = this.getPublicClient();
    const pools: EvmPoolInfo[] = [];

    if (tokenA && tokenB) {
      // Check both volatile and stable pools
      for (const stable of [false, true]) {
        try {
          const poolAddress = await client.readContract({
            address: addresses.factory,
            abi: AERODROME_FACTORY_ABI,
            functionName: 'getPool',
            args: [tokenA, tokenB, stable],
          });

          if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
            const poolInfo = await this.getPoolInfo(poolAddress as Address);
            if (poolInfo) {
              pools.push(poolInfo);
            }
          }
        } catch (error) {
          logger.debug(`[AerodromeLpService] No ${stable ? 'stable' : 'volatile'} pool found for ${tokenA}/${tokenB}`);
        }
      }
    }

    return pools;
  }

  private async getPoolInfo(poolAddress: Address): Promise<EvmPoolInfo | null> {
    const client = this.getPublicClient();

    try {
      const [token0, token1, stable, reserves] = await Promise.all([
        client.readContract({ address: poolAddress, abi: AERODROME_POOL_ABI, functionName: 'token0' }),
        client.readContract({ address: poolAddress, abi: AERODROME_POOL_ABI, functionName: 'token1' }),
        client.readContract({ address: poolAddress, abi: AERODROME_POOL_ABI, functionName: 'stable' }),
        client.readContract({ address: poolAddress, abi: AERODROME_POOL_ABI, functionName: 'getReserves' }),
      ]);

      const [symbol0, decimals0, symbol1, decimals1] = await Promise.all([
        client.readContract({ address: token0 as Address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: token0 as Address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
        client.readContract({ address: token1 as Address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        client.readContract({ address: token1 as Address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ]);

      const poolType: AerodromePoolType = stable ? 'stable' : 'volatile';

      const poolInfo: EvmPoolInfo = {
        id: poolAddress,
        dex: 'aerodrome',
        chainId: 8453,
        chainName: 'Base',
        poolAddress,
        tokenA: {
          address: token0 as Address,
          symbol: symbol0 as string,
          decimals: Number(decimals0),
          reserve: reserves[0].toString(),
        },
        tokenB: {
          address: token1 as Address,
          symbol: symbol1 as string,
          decimals: Number(decimals1),
          reserve: reserves[1].toString(),
        },
        fee: stable ? 0.0004 : 0.003, // 0.04% for stable, 0.3% for volatile
        displayName: `${symbol0}/${symbol1} (${poolType})`,
        metadata: {
          poolType,
          stable,
        },
      };

      return poolInfo;
    } catch (error) {
      logger.error(`[AerodromeLpService] Error fetching pool info for ${poolAddress}:`, error);
      return null;
    }
  }

  async addLiquidity(params: EvmAddLiquidityParams): Promise<EvmTransactionResult> {
    if (!this.supportsChain(params.chainId)) {
      return { success: false, error: `Chain ${params.chainId} not supported. Aerodrome is only on Base (8453).` };
    }

    const addresses = AERODROME_ADDRESSES[8453];

    try {
      const publicClient = this.getPublicClient();
      const walletClient = this.getWalletClient(params.wallet.privateKey);

      const poolInfo = await this.getPoolInfo(params.poolAddress);
      if (!poolInfo) {
        return { success: false, error: 'Pool not found' };
      }

      const stable = poolInfo.metadata?.stable === true;
      const slippageMultiplier = BigInt(10000 - params.slippageBps);
      const amountAMin = (params.tokenAAmount * slippageMultiplier) / 10000n;
      const amountBMin = ((params.tokenBAmount ?? 0n) * slippageMultiplier) / 10000n;

      // Approve tokens for router
      await this.approveToken(
        params.wallet.privateKey,
        poolInfo.tokenA.address,
        addresses.router,
        params.tokenAAmount
      );

      if (params.tokenBAmount && params.tokenBAmount > 0n) {
        await this.approveToken(
          params.wallet.privateKey,
          poolInfo.tokenB.address,
          addresses.router,
          params.tokenBAmount
        );
      }

      const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);

      const { request } = await publicClient.simulateContract({
        address: addresses.router,
        abi: AERODROME_ROUTER_ABI,
        functionName: 'addLiquidity',
        args: [
          poolInfo.tokenA.address,
          poolInfo.tokenB.address,
          stable,
          params.tokenAAmount,
          params.tokenBAmount ?? 0n,
          amountAMin,
          amountBMin,
          params.wallet.address,
          deadline,
        ],
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
          stable,
        },
      };
    } catch (error) {
      logger.error('[AerodromeLpService] Error adding liquidity:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error adding liquidity',
      };
    }
  }

  async removeLiquidity(params: EvmRemoveLiquidityParams): Promise<EvmTransactionResult> {
    if (!this.supportsChain(params.chainId)) {
      return { success: false, error: `Chain ${params.chainId} not supported. Aerodrome is only on Base (8453).` };
    }

    const addresses = AERODROME_ADDRESSES[8453];

    try {
      const publicClient = this.getPublicClient();
      const walletClient = this.getWalletClient(params.wallet.privateKey);

      const poolInfo = await this.getPoolInfo(params.poolAddress);
      if (!poolInfo) {
        return { success: false, error: 'Pool not found' };
      }

      const stable = poolInfo.metadata?.stable === true;

      // Get LP token balance
      let lpTokenAmount = params.lpTokenAmount;
      if (!lpTokenAmount) {
        const balance = await publicClient.readContract({
          address: params.poolAddress,
          abi: AERODROME_POOL_ABI,
          functionName: 'balanceOf',
          args: [params.wallet.address],
        });

        if (params.percentageToRemove && params.percentageToRemove < 100) {
          lpTokenAmount = ((balance as bigint) * BigInt(params.percentageToRemove)) / 100n;
        } else {
          lpTokenAmount = balance as bigint;
        }
      }

      if (!lpTokenAmount || lpTokenAmount === 0n) {
        return { success: false, error: 'No LP tokens to remove' };
      }

      // Approve LP tokens for router
      await this.approveToken(
        params.wallet.privateKey,
        params.poolAddress,
        addresses.router,
        lpTokenAmount
      );

      const slippageMultiplier = BigInt(10000 - params.slippageBps);
      const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);

      const { request } = await publicClient.simulateContract({
        address: addresses.router,
        abi: AERODROME_ROUTER_ABI,
        functionName: 'removeLiquidity',
        args: [
          poolInfo.tokenA.address,
          poolInfo.tokenB.address,
          stable,
          lpTokenAmount,
          0n, // amountAMin - will be calculated by slippage in real implementation
          0n, // amountBMin
          params.wallet.address,
          deadline,
        ],
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
      };
    } catch (error) {
      logger.error('[AerodromeLpService] Error removing liquidity:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error removing liquidity',
      };
    }
  }

  async getPositionDetails(
    chainId: number,
    owner: Address,
    poolAddress: Address,
    tokenId?: bigint // Ignored for Aerodrome - uses LP tokens not NFTs
  ): Promise<EvmPositionDetails | null> {
    if (!this.supportsChain(chainId)) return null;

    const client = this.getPublicClient();

    try {
      const poolInfo = await this.getPoolInfo(poolAddress);
      if (!poolInfo) return null;

      const lpBalance = await client.readContract({
        address: poolAddress,
        abi: AERODROME_POOL_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });

      if ((lpBalance as bigint) === 0n) return null;

      const totalSupply = await client.readContract({
        address: poolAddress,
        abi: AERODROME_POOL_ABI,
        functionName: 'totalSupply',
      });

      // Calculate underlying token amounts based on LP share
      const lpBalanceBigInt = lpBalance as bigint;
      const totalSupplyBigInt = totalSupply as bigint;
      const reserve0 = BigInt(poolInfo.tokenA.reserve ?? '0');
      const reserve1 = BigInt(poolInfo.tokenB.reserve ?? '0');

      const amount0 = totalSupplyBigInt > 0n 
        ? (reserve0 * lpBalanceBigInt) / totalSupplyBigInt 
        : 0n;
      const amount1 = totalSupplyBigInt > 0n 
        ? (reserve1 * lpBalanceBigInt) / totalSupplyBigInt 
        : 0n;

      return {
        poolId: poolAddress,
        dex: 'aerodrome',
        chainId: 8453,
        owner,
        lpTokenBalance: {
          address: poolAddress,
          balance: lpBalanceBigInt.toString(),
          decimals: 18,
          symbol: `AERO-LP-${poolInfo.tokenA.symbol}/${poolInfo.tokenB.symbol}`,
        },
        underlyingTokens: [
          {
            address: poolInfo.tokenA.address,
            balance: amount0.toString(),
            decimals: poolInfo.tokenA.decimals,
            symbol: poolInfo.tokenA.symbol,
          },
          {
            address: poolInfo.tokenB.address,
            balance: amount1.toString(),
            decimals: poolInfo.tokenB.decimals,
            symbol: poolInfo.tokenB.symbol,
          },
        ],
        metadata: poolInfo.metadata,
      };
    } catch (error) {
      logger.error(`[AerodromeLpService] Error getting position details for ${owner}:`, error);
      return null;
    }
  }

  async getAllPositions(chainId: number, owner: Address): Promise<EvmPositionDetails[]> {
    if (!this.supportsChain(chainId)) return [];

    // For Aerodrome, we would need to iterate through known pools
    // This is a simplified implementation - in production, you'd want to
    // track pools the user has interacted with or use an indexer
    logger.info(`[AerodromeLpService] getAllPositions not fully implemented - need pool tracking`);
    return [];
  }

  async getMarketData(poolAddresses: Address[]): Promise<Record<string, Partial<EvmPoolInfo>>> {
    const result: Record<string, Partial<EvmPoolInfo>> = {};

    for (const address of poolAddresses) {
      try {
        const poolInfo = await this.getPoolInfo(address);
        if (poolInfo) {
          result[address] = poolInfo;
        }
      } catch {
        // Pool not found
      }
    }

    return result;
  }

  private async approveToken(
    privateKey: `0x${string}`,
    tokenAddress: Address,
    spenderAddress: Address,
    amount: bigint
  ): Promise<void> {
    const publicClient = this.getPublicClient();
    const walletClient = this.getWalletClient(privateKey);

    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account!.address, spenderAddress],
    });

    if ((allowance as bigint) >= amount) {
      return;
    }

    logger.info(`[AerodromeLpService] Approving ${tokenAddress} for ${spenderAddress}`);

    const { request } = await publicClient.simulateContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spenderAddress, amount],
      account: walletClient.account,
    });

    const hash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });

    logger.info(`[AerodromeLpService] Token approved: ${hash}`);
  }
}
