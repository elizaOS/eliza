/**
 * Meteora DLMM adapter implementing the wallet plugin's DEX/LP surface
 * (`getPools`, `addLiquidity`, `removeLiquidity`, `getLpPositionDetails`,
 * `getMarketDataForPools`) against Meteora's public API and on-chain DLMM
 * program. Pool metadata comes from the Meteora DLMM API; liquidity math and
 * transaction building go through the `DLMM` SDK wrapper. Simplifications to
 * be aware of: `addLiquidity` always uses a fixed +/-10 bin spot strategy,
 * `removeLiquidity` always removes 100% of the first position found for the
 * pool, and USD valuation is not computed (no price oracle wired).
 */
import * as anchor from "@coral-xyz/anchor";
import {
  type IAgentRuntime,
  type LpPositionDetails,
  logger,
  type PoolInfo,
  Service,
  type TokenBalance,
  type TransactionResult,
} from "@elizaos/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { autoFillYByStrategy, DLMM, type LbPosition, StrategyType } from "../utils/dlmm.ts";
import { sendTransaction } from "../utils/sendTransaction.ts";
import {
  sumParsedTokenAccountBaseUnits,
  withdrawalReceivedBaseUnits,
} from "./token-account-base-units.ts";

const { BN } = anchor;
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

/** Pool shape from the Meteora DLMM Data API. */
interface MeteoraPoolResponse {
  address: string;
  name: string;
  token_x: MeteoraTokenResponse;
  token_y: MeteoraTokenResponse;
  apy: number;
  tvl: number;
}

interface MeteoraTokenResponse {
  address: string;
  symbol: string;
  decimals: number;
}

interface MeteoraPoolsPage {
  current_page: number;
  pages: number;
  data: MeteoraPoolResponse[];
}

/** The Meteora API did not return a usable pool catalog. */
export class MeteoraPoolDiscoveryError extends Error {
  public readonly code = "METEORA_POOL_DISCOVERY_FAILED";

  constructor(
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MeteoraPoolDiscoveryError";
  }
}

export class MeteoraLpService extends Service {
  [key: string]: unknown;

  public static readonly serviceType = "meteora-lp";
  public readonly capabilityDescription =
    "Provides standardized access to DEX liquidity pools." as const;
  private connection: Connection;
  private readonly METEORA_API_URL = "https://dlmm.datapi.meteora.ag/pools";

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    const rpcUrl = getRuntimeStringSetting(runtime, "SOLANA_RPC_URL") ?? DEFAULT_SOLANA_RPC_URL;
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  static async start(runtime: IAgentRuntime): Promise<MeteoraLpService> {
    const service = new MeteoraLpService(runtime);
    console.info("[MeteoraLpService] started.");
    return service;
  }

  async stop(): Promise<void> {
    console.info("[MeteoraLpService] stopped.");
  }

  public getDexName(): string {
    return "meteora";
  }

  public async getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]> {
    try {
      const filters = poolFilters(tokenAMint, tokenBMint);
      const poolsByAddress = new Map<string, MeteoraPoolResponse>();

      for (const filter of filters) {
        for (const pool of await this.fetchPools(filter)) {
          poolsByAddress.set(pool.address, pool);
        }
      }

      const pools = Array.from(poolsByAddress.values()).map(
        (pool): PoolInfo => ({
          id: pool.address,
          displayName: pool.name,
          dex: "meteora",
          tokenA: {
            mint: pool.token_x.address,
            symbol: pool.token_x.symbol,
            decimals: pool.token_x.decimals,
          },
          tokenB: {
            mint: pool.token_y.address,
            symbol: pool.token_y.symbol,
            decimals: pool.token_y.decimals,
          },
          apy: pool.apy / 100,
          tvl: pool.tvl,
        })
      );

      if (tokenAMint && tokenBMint) {
        return pools.filter(
          (pool: PoolInfo) =>
            (pool.tokenA.mint === tokenAMint && pool.tokenB.mint === tokenBMint) ||
            (pool.tokenA.mint === tokenBMint && pool.tokenB.mint === tokenAMint)
        );
      }

      return pools;
    } catch (error) {
      const typedError =
        error instanceof MeteoraPoolDiscoveryError
          ? error
          : new MeteoraPoolDiscoveryError("Meteora returned an unusable pool catalog", undefined, {
              cause: error,
            });
      this.runtime?.reportError("meteora.poolDiscovery", typedError);
      throw typedError;
    }
  }

  private async fetchPools(filter?: string): Promise<MeteoraPoolResponse[]> {
    const firstPage = await this.fetchPoolsPage(1, filter);
    if (firstPage.current_page !== 1) {
      throw new Error(`Meteora returned page ${firstPage.current_page} when page 1 was requested`);
    }
    const pools = [...firstPage.data];

    for (let page = 2; page <= firstPage.pages; page += 1) {
      const nextPage = await this.fetchPoolsPage(page, filter);
      if (nextPage.current_page !== page) {
        throw new Error(
          `Meteora returned page ${nextPage.current_page} when page ${page} was requested`
        );
      }
      pools.push(...nextPage.data);
    }

    return pools;
  }

  private async fetchPoolsPage(page: number, filter?: string): Promise<MeteoraPoolsPage> {
    const url = new URL(this.METEORA_API_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    if (filter) {
      url.searchParams.set("filter_by", filter);
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new MeteoraPoolDiscoveryError(
        `Meteora pool request failed with status ${response.status}`,
        response.status
      );
    }
    return parsePoolsPage(await response.json());
  }

  public async addLiquidity(params: {
    userVault: Keypair;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    slippageBps: number;
    tickLowerIndex?: number;
    tickUpperIndex?: number;
    tokenAMint?: string;
  }): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(params.poolId));
      const activeBin = await dlmmPool.getActiveBin();

      // For now, we'll use a simple strategy of 10 bins on each side of the active bin.
      // This should be made more configurable in the future.
      const TOTAL_RANGE_INTERVAL = 10;
      const minBinId = activeBin.binId - TOTAL_RANGE_INTERVAL;
      const maxBinId = activeBin.binId + TOTAL_RANGE_INTERVAL;

      const totalXAmount = new BN(params.tokenAAmountLamports);
      // If tokenBAmount is not provided, we can auto-fill it.
      const totalYAmount = params.tokenBAmountLamports
        ? new BN(params.tokenBAmountLamports)
        : autoFillYByStrategy(
            activeBin.binId,
            dlmmPool.lbPair.binStep,
            totalXAmount,
            activeBin.xAmount,
            activeBin.yAmount,
            minBinId,
            maxBinId,
            StrategyType.Spot
          );

      const newPosition = Keypair.generate();

      const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: params.userVault.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId,
          minBinId,
          strategyType: StrategyType.Spot,
        },
      });

      // initializePosition marks the new position account as a signer.
      // The official SDK example signs with [user, positionKeypair].
      const signature = await sendTransaction(
        this.connection,
        createPositionTx.instructions,
        params.userVault,
        [newPosition]
      );

      // Wait for the transaction to be confirmed to ensure the position is created.
      await this.connection.confirmTransaction(signature, "confirmed");

      // Fetch the newly created position to get the exact liquidity amount.
      const position = await dlmmPool.getPosition(newPosition.publicKey);
      const totalLiquidity = position.positionData.positionBinData.reduce(
        (acc: anchor.BN, bin: { binLiquidity: string }) => acc.add(new BN(bin.binLiquidity)),
        new BN(0)
      );

      return {
        success: true,
        transactionId: signature,
        lpTokensReceived: {
          address: newPosition.publicKey.toBase58(),
          balance: totalLiquidity.toString(),
          decimals: 0, // DLMM position NFTs don't have standard decimals
          symbol: "METEORA-POS",
        },
      };
    } catch (error) {
      console.error("[MeteoraLpService] Error adding liquidity:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async removeLiquidity(params: {
    userVault: Keypair;
    poolId: string;
    // This is not directly usable for DLMM pools, as we need to specify BPS to remove per bin.
    // For now, we will assume this means "remove all liquidity".
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(params.poolId));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
        params.userVault.publicKey
      );

      if (userPositions.length === 0) {
        throw new Error("No positions found for this user in the specified pool.");
      }

      const poolInfo = (await this.getPools()).find((p) => p.id === params.poolId);
      if (!poolInfo) {
        throw new Error(`Could not find pool info for ${params.poolId}`);
      }

      const tokenAMint = new PublicKey(poolInfo.tokenA.mint);
      const tokenBMint = new PublicKey(poolInfo.tokenB.mint);

      // Read before the withdrawal. A failed read throws and the outer catch
      // returns before any transaction is sent.
      const preBalanceA = await this.getTokenBalance(params.userVault.publicKey, tokenAMint);
      const preBalanceB = await this.getTokenBalance(params.userVault.publicKey, tokenBMint);

      // For simplicity, we'll remove liquidity from the first position found.
      const position = userPositions[0];

      const binIdsToRemove = position.positionData.positionBinData.map((bin) => bin.binId);

      // ILpService has no DLMM percentage/bin selection fields yet, so this
      // adapter removes 100% of the selected position.
      const removeLiquidityTx = await dlmmPool.removeLiquidity({
        position: position.publicKey,
        user: params.userVault.publicKey,
        fromBinId: binIdsToRemove[0],
        toBinId: binIdsToRemove[binIdsToRemove.length - 1],
        bps: new BN(100 * 100), // 100%
        shouldClaimAndClose: true,
      });

      // The removeLiquidity function can return an array of transactions
      const txs = Array.isArray(removeLiquidityTx) ? removeLiquidityTx : [removeLiquidityTx];

      let lastSignature = "";
      for (const tx of txs) {
        lastSignature = await sendTransaction(this.connection, tx.instructions, params.userVault);
        await this.connection.confirmTransaction(lastSignature, "confirmed");
      }

      // The withdrawal is already confirmed. A failed post-read must not
      // become a zero balance, and it must not hide the signature.
      let tokensReceived: TokenBalance[] | undefined;
      try {
        const postBalanceA = await this.getTokenBalance(params.userVault.publicKey, tokenAMint);
        const postBalanceB = await this.getTokenBalance(params.userVault.publicKey, tokenBMint);
        const receivedA = withdrawalReceivedBaseUnits(postBalanceA, preBalanceA);
        const receivedB = withdrawalReceivedBaseUnits(postBalanceB, preBalanceB);
        if (receivedA !== null && receivedB !== null) {
          tokensReceived = [
            {
              address: poolInfo.tokenA.mint,
              symbol: poolInfo.tokenA.symbol,
              decimals: poolInfo.tokenA.decimals ?? 0,
              balance: receivedA,
            },
            {
              address: poolInfo.tokenB.mint,
              symbol: poolInfo.tokenB.symbol,
              decimals: poolInfo.tokenB.decimals ?? 0,
              balance: receivedB,
            },
          ];
        }
      } catch (error) {
        // Diagnostics cannot turn a confirmed withdrawal into a failed receipt.
        try {
          logger.error(
            { error, poolId: params.poolId, transactionId: lastSignature },
            "Meteora withdrawal confirmed but token balance read failed"
          );
          this.runtime?.reportError("meteora.withdrawal.balance", error, {
            poolId: params.poolId,
            transactionId: lastSignature,
          });
        } catch {
          // error-policy:J7 retain the confirmed signature if diagnostics fail.
        }
      }

      return {
        success: true,
        transactionId: lastSignature,
        ...(tokensReceived ? { tokensReceived } : {}),
      };
    } catch (error) {
      logger.error({ error, poolId: params.poolId }, "Meteora withdrawal failed");
      this.runtime?.reportError("meteora.withdrawal", error, { poolId: params.poolId });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string
  ): Promise<LpPositionDetails | null> {
    try {
      const userPubKey = new PublicKey(userAccountPublicKey);

      let position: LbPosition | null = null;
      let poolAddress: string = "";

      try {
        // First, assume the identifier is a position public key
        const positionPubKey = new PublicKey(poolOrPositionIdentifier);
        const positionAccount = await this.connection.getAccountInfo(positionPubKey);
        if (!positionAccount) {
          throw new Error(`Position account not found: ${poolOrPositionIdentifier}`);
        }
        const dlmmPool = await DLMM.create(this.connection, positionAccount.owner);
        position = await dlmmPool.getPosition(positionPubKey);
        poolAddress = dlmmPool.pubkey.toBase58();
      } catch (_e) {
        // If that fails, assume it's a pool address
        try {
          const dlmmPool = await DLMM.create(
            this.connection,
            new PublicKey(poolOrPositionIdentifier)
          );
          const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubKey);
          if (userPositions.length > 0) {
            position = userPositions[0];
            poolAddress = poolOrPositionIdentifier;
          }
        } catch (poolError) {
          console.error(
            `[MeteoraLpService] Failed to find position or pool for identifier: ${poolOrPositionIdentifier}`,
            poolError
          );
          return null;
        }
      }

      if (!position) {
        return null; // No position found
      }

      const poolInfo = (await this.getPools()).find((p) => p.id === poolAddress);
      if (!poolInfo) {
        throw new Error(`Could not find pool info for ${poolAddress}`);
      }

      const totalLiquidity = position.positionData.positionBinData.reduce(
        (acc: anchor.BN, bin: { binLiquidity: string }) => acc.add(new BN(bin.binLiquidity)),
        new BN(0)
      );

      const underlyingTokens: TokenBalance[] = [
        {
          ...poolInfo.tokenA,
          address: poolInfo.tokenA.mint,
          decimals: poolInfo.tokenA.decimals ?? 0,
          balance: position.positionData.totalXAmount,
        },
        {
          ...poolInfo.tokenB,
          address: poolInfo.tokenB.mint,
          decimals: poolInfo.tokenB.decimals ?? 0,
          balance: position.positionData.totalYAmount,
        },
      ];

      return {
        poolId: poolAddress,
        dex: "meteora",
        lpTokenBalance: {
          address: position.publicKey.toBase58(),
          balance: totalLiquidity.toString(),
          decimals: 0,
          symbol: "METEORA-POS",
        },
        underlyingTokens,
        valueUsd: 0, // USD valuation is unavailable until a price oracle is wired.
        accruedFees: [],
        rewards: [],
      };
    } catch (error) {
      if (error instanceof MeteoraPoolDiscoveryError) {
        throw error;
      }
      console.error("[MeteoraLpService] Error getting LP position details:", error);
      return null;
    }
  }

  public async getMarketDataForPools(
    poolIds: string[]
  ): Promise<Record<string, Partial<PoolInfo>>> {
    const allPools = await this.getPools();
    const marketData: Record<string, Partial<PoolInfo>> = {};

    for (const poolId of poolIds) {
      const poolInfo = allPools.find((p) => p.id === poolId);
      if (poolInfo) {
        marketData[poolId] = {
          apy: poolInfo.apy,
          tvl: poolInfo.tvl,
        };
      }
    }

    return marketData;
  }

  private async getTokenBalance(walletAddress: PublicKey, mintAddress: PublicKey): Promise<bigint> {
    // An empty account list is a real zero. getParsedTokenAccountsByOwner
    // throws on RPC failure; that error must reach the caller.
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletAddress, {
      mint: mintAddress,
    });
    return sumParsedTokenAccountBaseUnits(tokenAccounts.value);
  }
}

function getRuntimeStringSetting(
  runtime: IAgentRuntime | undefined,
  key: string
): string | undefined {
  const value = runtime?.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function poolFilters(tokenAMint?: string, tokenBMint?: string): Array<string | undefined> {
  if (!tokenAMint || !tokenBMint) {
    return [undefined];
  }
  const forward = `token_x=${tokenAMint} && token_y=${tokenBMint}`;
  if (tokenAMint === tokenBMint) {
    return [forward];
  }
  return [forward, `token_x=${tokenBMint} && token_y=${tokenAMint}`];
}

function parsePoolsPage(value: unknown): MeteoraPoolsPage {
  if (!isRecord(value)) {
    throw new Error("Meteora pool response is not an object");
  }
  const { current_page: currentPage, pages, data } = value;
  if (!Number.isSafeInteger(currentPage) || (currentPage as number) < 0) {
    throw new Error("Meteora pool response has an invalid current_page");
  }
  if (!Number.isSafeInteger(pages) || (pages as number) < 0) {
    throw new Error("Meteora pool response has an invalid pages value");
  }
  if (!Array.isArray(data)) {
    throw new Error("Meteora pool response has no data array");
  }

  return {
    current_page: currentPage as number,
    pages: pages as number,
    data: data.map(parsePool),
  };
}

function parsePool(value: unknown): MeteoraPoolResponse {
  if (!isRecord(value)) {
    throw new Error("Meteora pool entry is not an object");
  }
  return {
    address: requiredString(value.address, "pool address"),
    name: requiredString(value.name, "pool name"),
    token_x: parseToken(value.token_x, "token_x"),
    token_y: parseToken(value.token_y, "token_y"),
    apy: requiredFiniteNumber(value.apy, "pool apy"),
    tvl: requiredFiniteNumber(value.tvl, "pool tvl"),
  };
}

function parseToken(value: unknown, field: string): MeteoraTokenResponse {
  if (!isRecord(value)) {
    throw new Error(`Meteora ${field} is not an object`);
  }
  const decimals = requiredFiniteNumber(value.decimals, `${field} decimals`);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Meteora ${field} decimals is invalid`);
  }
  return {
    address: requiredString(value.address, `${field} address`),
    symbol: value.symbol === "" ? "Unknown" : requiredString(value.symbol, `${field} symbol`),
    decimals,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Meteora ${field} is invalid`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Meteora ${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
