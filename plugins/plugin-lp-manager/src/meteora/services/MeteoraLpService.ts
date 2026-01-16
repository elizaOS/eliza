import * as anchor from '@coral-xyz/anchor';
import { IAgentRuntime, Service, LpPositionDetails, PoolInfo, TokenBalance, TransactionResult } from '@elizaos/core';
import { DLMM, StrategyType, autoFillYByStrategy } from '../utils/dlmm.ts';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { sendTransaction } from '../utils/sendTransaction.ts';
const { BN } = anchor;

export class MeteoraLpService extends Service {
  public static readonly serviceType = 'meteora-lp';
  public readonly capabilityDescription = 'Provides liquidity pool data and interaction for the Meteora DEX.';
  private connection: Connection;
  private readonly METEORA_API_URL = 'https://dlmm-api.meteora.ag/pair/all';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    const rpcUrl = runtime.getSetting('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  static async start(runtime: IAgentRuntime): Promise<MeteoraLpService> {
    const service = new MeteoraLpService(runtime);
    console.info('[MeteoraLpService] started.');
    return service;
  }

  async stop(): Promise<void> {
    console.info('[MeteoraLpService] stopped.');
  }

  public getDexName(): string {
    return 'meteora';
  }

  public async getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]> {
    try {
      const response = await fetch(this.METEORA_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = (await response.json()) as any[];
      
      let pools = data.map((pool: any): PoolInfo => ({
        id: pool.address,
        dex: 'meteora',
        tokenA: { 
          mint: pool.mint_x, 
          symbol: pool.name_x || 'Unknown', // Provide default if symbol is missing
          decimals: pool.decimals_x 
        },
        tokenB: { 
          mint: pool.mint_y, 
          symbol: pool.name_y || 'Unknown', // Provide default if symbol is missing
          decimals: pool.decimals_y 
        },
        // The API does not provide APY or TVL directly in this endpoint.
        // These would need to be fetched from another source or calculated.
        apy: pool.apr ? pool.apr / 100 : 0, // Handle missing apr field
        tvl: pool.liquidity ? parseFloat(pool.liquidity) : 0, // Parse liquidity string to number
      }));

      if (tokenAMint && tokenBMint) {
        return pools.filter((pool: PoolInfo) => 
          (pool.tokenA.mint === tokenAMint && pool.tokenB.mint === tokenBMint) ||
          (pool.tokenA.mint === tokenBMint && pool.tokenB.mint === tokenAMint)
        );
      }

      return pools;
    } catch (error) {
        console.error('[MeteoraLpService] Error fetching pools from Meteora API:', error);
        return [];
    }
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

        const signature = await sendTransaction(this.connection, createPositionTx.instructions, params.userVault);

        // Wait for the transaction to be confirmed to ensure the position is created.
        await this.connection.confirmTransaction(signature, 'confirmed');

        // Fetch the newly created position to get the exact liquidity amount.
        const position = await dlmmPool.getPosition(newPosition.publicKey);
        const totalLiquidity = position.positionData.positionBinData.reduce((acc: anchor.BN, bin: { binLiquidity: string }) => acc.add(new BN(bin.binLiquidity)), new BN(0));

        return {
            success: true,
            transactionId: signature,
            lpTokensReceived: {
                address: newPosition.publicKey.toBase58(),
                balance: totalLiquidity.toString(),
                decimals: 0, // DLMM position NFTs don't have standard decimals
                symbol: 'METEORA-POS',
            },
        };

    } catch (error: any) {
        console.error('[MeteoraLpService] Error adding liquidity:', error);
        return {
            success: false,
            error: error.message,
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
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(params.userVault.publicKey);

        if (userPositions.length === 0) {
            throw new Error('No positions found for this user in the specified pool.');
        }

        const poolInfo = (await this.getPools()).find(p => p.id === params.poolId);
        if (!poolInfo) {
            throw new Error(`Could not find pool info for ${params.poolId}`);
        }

        const tokenAMint = new PublicKey(poolInfo.tokenA.mint);
        const tokenBMint = new PublicKey(poolInfo.tokenB.mint);

        // Get balances before withdrawal
        const preBalanceA = await this.getTokenBalance(params.userVault.publicKey, tokenAMint);
        const preBalanceB = await this.getTokenBalance(params.userVault.publicKey, tokenBMint);

        // For simplicity, we'll remove liquidity from the first position found.
        const position = userPositions[0];
        
        const binIdsToRemove = position.positionData.positionBinData.map((bin) => bin.binId);

        // TODO: The ILpService interface is not ideal for DLMMs. 
        // We are forced to assume removing 100% of liquidity here.
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
        
        let lastSignature = '';
        for (const tx of txs) {
            lastSignature = await sendTransaction(this.connection, tx.instructions, params.userVault);
            await this.connection.confirmTransaction(lastSignature, 'confirmed');
        }

        // Get balances after withdrawal
        const postBalanceA = await this.getTokenBalance(params.userVault.publicKey, tokenAMint);
        const postBalanceB = await this.getTokenBalance(params.userVault.publicKey, tokenBMint);

        const tokensReceived: TokenBalance[] = [
            {
                address: poolInfo.tokenA.mint,
                symbol: poolInfo.tokenA.symbol,
                decimals: poolInfo.tokenA.decimals ?? 0,
                balance: postBalanceA.sub(preBalanceA).toString(),
            },
            {
                address: poolInfo.tokenB.mint,
                symbol: poolInfo.tokenB.symbol,
                decimals: poolInfo.tokenB.decimals ?? 0,
                balance: postBalanceB.sub(preBalanceB).toString(),
            }
        ];

        return {
            success: true,
            transactionId: lastSignature,
            tokensReceived,
        };
    } catch (error: any) {
        console.error('[MeteoraLpService] Error removing liquidity:', error);
        return {
            success: false,
            error: error.message,
        };
    }
  }

  public async getLpPositionDetails(userAccountPublicKey: string, poolOrPositionIdentifier: string): Promise<LpPositionDetails | null> {
    try {
        const userPubKey = new PublicKey(userAccountPublicKey);
        
        let position: any = null;
        let poolAddress: string = '';

        try {
            // First, assume the identifier is a position public key
            const positionPubKey = new PublicKey(poolOrPositionIdentifier);
            const dlmmPool = await DLMM.create(this.connection, (await this.connection.getAccountInfo(positionPubKey))!.owner);
            position = await dlmmPool.getPosition(positionPubKey);
            poolAddress = dlmmPool.pubkey.toBase58();
        } catch (e) {
            // If that fails, assume it's a pool address
            try {
                const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolOrPositionIdentifier));
                const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubKey);
                if (userPositions.length > 0) {
                    position = userPositions[0];
                    poolAddress = poolOrPositionIdentifier;
                }
            } catch (poolError) {
                console.error(`[MeteoraLpService] Failed to find position or pool for identifier: ${poolOrPositionIdentifier}`, poolError);
                return null;
            }
        }

        if (!position) {
            return null; // No position found
        }
        
        const poolInfo = (await this.getPools()).find(p => p.id === poolAddress);
        if (!poolInfo) {
            throw new Error(`Could not find pool info for ${poolAddress}`);
        }

        const { x, y } = position.getAmounts();
        const totalLiquidity = position.positionData.positionBinData.reduce((acc: anchor.BN, bin: { binLiquidity: string }) => acc.add(new BN(bin.binLiquidity)), new BN(0));

        const underlyingTokens: TokenBalance[] = [
            {
                ...poolInfo.tokenA,
                address: poolInfo.tokenA.mint,
                decimals: poolInfo.tokenA.decimals ?? 0,
                balance: x.toString()
            },
            {
                ...poolInfo.tokenB,
                address: poolInfo.tokenB.mint,
                decimals: poolInfo.tokenB.decimals ?? 0,
                balance: y.toString()
            }
        ];

        return {
            poolId: poolAddress,
            dex: 'meteora',
            lpTokenBalance: {
                address: position.publicKey.toBase58(),
                balance: totalLiquidity.toString(),
                decimals: 0, 
                symbol: 'METEORA-POS'
            },
            underlyingTokens,
            valueUsd: 0, // TODO: requires a price oracle
        };

    } catch (error: any) {
        console.error('[MeteoraLpService] Error getting LP position details:', error);
        return null;
    }
  }

  public async getMarketDataForPools(poolIds: string[]): Promise<Record<string, Partial<PoolInfo>>> {
    try {
        const allPools = await this.getPools();
        const marketData: Record<string, Partial<PoolInfo>> = {};

        for (const poolId of poolIds) {
            const poolInfo = allPools.find(p => p.id === poolId);
            if (poolInfo) {
                marketData[poolId] = {
                    apy: poolInfo.apy,
                    tvl: poolInfo.tvl,
                };
            }
        }

        return marketData;
    } catch (error) {
        console.error('[MeteoraLpService] Error getting market data for pools:', error);
        return {};
    }
  }

  private async getTokenBalance(walletAddress: PublicKey, mintAddress: PublicKey): Promise<anchor.BN> {
    try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletAddress, { mint: mintAddress });
        if (tokenAccounts.value.length > 0) {
            const balance = tokenAccounts.value[0].account.data.parsed.info.uiAmount;
            const decimals = tokenAccounts.value[0].account.data.parsed.info.decimals;
            // Convert UI amount to lamports
            return new BN(balance * Math.pow(10, decimals));
        }
        return new BN(0);
    } catch (e) {
        // This can happen if the token account doesn't exist.
        return new BN(0);
    }
  }
}
