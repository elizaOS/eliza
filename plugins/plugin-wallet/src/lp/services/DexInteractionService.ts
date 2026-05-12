import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  AddLiquidityConfig,
  IEvmLpService,
  ILpService,
  IUserLpProfileService,
  LpPositionDetails,
  PoolInfo,
  RemoveLiquidityConfig,
  TransactionResult,
} from "../types.ts";
import {
  createEvmLpProtocolProvider,
  createSolanaLpProtocolProvider,
  getLpManagementService,
  type LpManagementService,
} from "./LpManagementService.ts";
import type { UserLpProfileService } from "./UserLpProfileService.ts";
import type { VaultService } from "./VaultService.ts";

/**
 * Backward-compatible facade for older LP manager internals.
 * New routing and protocol ownership live in LpManagementService.
 */
export interface IDexInteractionService extends Service {
  registerDexService(dexService: ILpService | IEvmLpService): void;
  getPools(
    dexName?: string,
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]>;
  addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult>;
  removeLiquidity(config: RemoveLiquidityConfig): Promise<TransactionResult>;
  getLpPosition(
    userId: string,
    poolIdOrPositionIdentifier: string,
    dexName: string,
  ): Promise<LpPositionDetails | null>;
  getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]>;
}

export class DexInteractionService
  extends Service
  implements IDexInteractionService
{
  public static override readonly serviceType = "dex-interaction";
  public readonly capabilityDescription =
    "Compatibility facade for registered LP protocol providers.";

  private lpManagementService!: LpManagementService;
  private userLpProfileService!: IUserLpProfileService;

  static async start(runtime: IAgentRuntime): Promise<DexInteractionService> {
    const service = new DexInteractionService(runtime);
    await service.start(runtime);
    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    // No static cleanup needed.
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    const vaultService = runtime.getService<VaultService>("VaultService");
    const userLpProfileService = runtime.getService<UserLpProfileService>(
      "UserLpProfileService",
    );
    const lpManagementService = await getLpManagementService(runtime);

    if (!vaultService || !userLpProfileService || !lpManagementService) {
      throw new Error(
        "Required services (VaultService, UserLpProfileService, LpManagementService) not available.",
      );
    }

    this.userLpProfileService = userLpProfileService;
    this.lpManagementService = lpManagementService;
  }

  async stop(): Promise<void> {
    // No-op; protocol providers are owned by LpManagementService.
  }

  rediscoverServices(): void {
    // Retained for callers that used to trigger name-based discovery.
  }

  registerDexService(dexService: ILpService | IEvmLpService): void {
    const dexName = dexService.getDexName();
    const isEvm =
      typeof (dexService as IEvmLpService).getSupportedChainIds === "function";

    this.lpManagementService.registerProtocol(
      isEvm
        ? createEvmLpProtocolProvider({
            dex: dexName,
            label: dexName,
            service: dexService as IEvmLpService,
          })
        : createSolanaLpProtocolProvider({
            dex: dexName,
            label: dexName,
            service: dexService as ILpService,
          }),
    );
  }

  getLpService(dexName: string): ILpService | IEvmLpService | undefined {
    return this.lpManagementService.listProtocols({ dex: dexName })[0]
      ?.service as ILpService | IEvmLpService | undefined;
  }

  getLpServices(): Array<ILpService | IEvmLpService> {
    return this.lpManagementService
      .listProtocols()
      .map((protocol) => protocol.service)
      .filter(Boolean) as Array<ILpService | IEvmLpService>;
  }

  getDexService(dexName: string): ILpService | IEvmLpService {
    const service = this.getLpService(dexName);
    if (!service) {
      throw new Error(`No service registered for DEX '${dexName}'`);
    }
    return service;
  }

  async getPools(
    dexName?: string,
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]> {
    try {
      return await this.lpManagementService.listPools({
        dex: dexName,
        tokenA: tokenAMint,
        tokenB: tokenBMint,
      });
    } catch (error) {
      logger.warn(
        "[DexInteractionService] Failed to list LP pools",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  async addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult> {
    return this.lpManagementService.openPosition({
      chain: "solana",
      dex: config.dexName,
      userVault: config.userVault,
      pool: config.poolId,
      amount: {
        tokenA: config.tokenAAmountLamports,
        tokenB: config.tokenBAmountLamports,
      },
      range: {
        tickLowerIndex: config.tickLowerIndex,
        tickUpperIndex: config.tickUpperIndex,
      },
      slippageBps: config.slippageBps,
    });
  }

  async removeLiquidity(
    config: RemoveLiquidityConfig,
  ): Promise<TransactionResult> {
    return this.lpManagementService.closePosition({
      chain: "solana",
      dex: config.dexName,
      userVault: config.userVault,
      pool: config.poolId,
      amount: { lpToken: config.lpTokenAmountLamports },
      slippageBps: config.slippageBps,
    });
  }

  async getLpPosition(
    userId: string,
    poolIdOrPositionIdentifier: string,
    dexName: string,
  ): Promise<LpPositionDetails | null> {
    const profile = await this.userLpProfileService.getProfile(userId);
    if (!profile?.vaultPublicKey) {
      throw new Error(
        `User profile or vault public key not found for user ${userId}.`,
      );
    }
    return this.lpManagementService.getPosition({
      dex: dexName,
      owner: profile.vaultPublicKey,
      pool: poolIdOrPositionIdentifier,
      position: poolIdOrPositionIdentifier,
    });
  }

  async getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]> {
    const profile = await this.userLpProfileService.getProfile(userId);
    if (!profile) return [];

    const trackedPositions =
      await this.userLpProfileService.getTrackedPositions(userId);

    const positions: LpPositionDetails[] = [];
    for (const tracked of trackedPositions) {
      try {
        const position = await this.lpManagementService.getPosition({
          dex: tracked.dex,
          owner: profile.vaultPublicKey,
          pool: tracked.poolAddress,
          position: tracked.positionIdentifier,
        });
        if (position) positions.push(position);
      } catch (error) {
        logger.warn(
          `[DexInteractionService] Failed to fetch LP position ${tracked.positionIdentifier}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return positions;
  }
}
