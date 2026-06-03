import { createHash } from "node:crypto";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  IConcentratedLiquidityService,
  IConcentratedPosition,
  IRangeParams,
} from "../types";

/**
 * ConcentratedLiquidityService tracks off-chain concentrated-liquidity plans and
 * range calculations. Protocol-specific DEX services own transaction submission.
 */
export class ConcentratedLiquidityService
  extends Service
  implements IConcentratedLiquidityService
{
  public static readonly serviceType = "concentrated-liquidity";
  public readonly capabilityDescription =
    "Manages concentrated liquidity positions with range selection and automated rebalancing";

  private positionsByUser = new Map<string, IConcentratedPosition[]>();

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ConcentratedLiquidityService> {
    const service = new ConcentratedLiquidityService(runtime);
    await service.start(runtime);
    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    // No cleanup needed for static stop
  }

  async start(_runtime: IAgentRuntime): Promise<void> {
    logger.info(
      "[ConcentratedLiquidityService] started for off-chain range tracking",
    );
  }

  async stop(): Promise<void> {}

  async createConcentratedPosition(
    userId: string,
    params: IRangeParams,
  ): Promise<IConcentratedPosition> {
    const position = this.buildPosition(
      userId,
      params,
      this.positionsByUser.get(userId)?.length ?? 0,
    );
    const positions = this.positionsByUser.get(userId) ?? [];
    this.positionsByUser.set(userId, [...positions, position]);
    return position;
  }

  async getConcentratedPositions(
    userId: string,
  ): Promise<IConcentratedPosition[]> {
    return [...(this.positionsByUser.get(userId) ?? [])];
  }

  async rebalanceConcentratedPosition(
    userId: string,
    positionId: string,
    newRangeParams?: Partial<IRangeParams>,
  ): Promise<IConcentratedPosition> {
    const positions = this.positionsByUser.get(userId) ?? [];
    const existingIndex = positions.findIndex(
      (position) => position.lpTokenBalance.address === positionId,
    );
    if (existingIndex === -1) {
      throw new Error(`Concentrated position ${positionId} not found.`);
    }

    const existing = positions[existingIndex];
    const rangeParams: IRangeParams = {
      poolAddress: existing.poolId,
      priceLower: existing.priceLower,
      priceUpper: existing.priceUpper,
      ...newRangeParams,
    };
    const updated = this.buildPosition(userId, rangeParams, existingIndex, {
      existing,
      action: "rebalance",
    });
    positions[existingIndex] = updated;
    this.positionsByUser.set(userId, [...positions]);
    return updated;
  }

  /**
   * Calculate optimal price range based on volatility and target utilization
   */
  calculateOptimalRange(
    currentPrice: number,
    rangeWidthPercent: number,
    _targetUtilization: number = 80,
  ): { priceLower: number; priceUpper: number } {
    // Simple symmetric range calculation
    const halfWidth = rangeWidthPercent / 2;
    const priceLower = currentPrice * (1 - halfWidth / 100);
    const priceUpper = currentPrice * (1 + halfWidth / 100);

    return { priceLower, priceUpper };
  }

  /**
   * Check if current price is within the position's range
   */
  isPriceInRange(
    currentPrice: number,
    priceLower: number,
    priceUpper: number,
  ): boolean {
    return currentPrice >= priceLower && currentPrice <= priceUpper;
  }

  /**
   * Calculate how much of the liquidity is currently active
   */
  calculateUtilization(
    currentPrice: number,
    priceLower: number,
    priceUpper: number,
  ): number {
    if (!this.isPriceInRange(currentPrice, priceLower, priceUpper)) {
      return 0;
    }

    const priceRange = priceUpper - priceLower;
    const distanceFromLower = currentPrice - priceLower;
    const distanceFromUpper = priceUpper - currentPrice;

    // Liquidity utilization is highest when price is in the middle of the range
    const utilization =
      (Math.min(distanceFromLower, distanceFromUpper) / (priceRange / 2)) * 100;
    return Math.min(utilization, 100);
  }

  private buildPosition(
    userId: string,
    params: IRangeParams,
    index: number,
    options?: {
      existing?: IConcentratedPosition;
      action?: "create" | "rebalance";
    },
  ): IConcentratedPosition {
    const currentPrice = this.resolveCurrentPrice(params);
    const range = this.resolveRange(params, currentPrice);
    const inRange = this.isPriceInRange(
      currentPrice,
      range.priceLower,
      range.priceUpper,
    );
    const liquidityUtilization = this.calculateUtilization(
      currentPrice,
      range.priceLower,
      range.priceUpper,
    );
    const positionId =
      options?.existing?.lpTokenBalance.address ??
      this.createPositionId(userId, params.poolAddress, index);

    return {
      poolId: params.poolAddress,
      dex: "concentrated-liquidity",
      lpTokenBalance: {
        address: positionId,
        balance: String((params.baseAmount ?? 0) + (params.quoteAmount ?? 0)),
        decimals: 0,
        symbol: "CL-POS",
      },
      underlyingTokens: [
        {
          address: `${params.poolAddress}:base`,
          balance: String(params.baseAmount ?? 0),
          decimals: 0,
          symbol: "BASE",
        },
        {
          address: `${params.poolAddress}:quote`,
          balance: String(params.quoteAmount ?? 0),
          decimals: 0,
          symbol: "QUOTE",
        },
      ],
      valueUsd: 0,
      accruedFees: [],
      rewards: [],
      metadata: {
        mode: "off-chain-plan",
        action: options?.action ?? "create",
        targetUtilization: params.targetUtilization ?? null,
      },
      priceLower: range.priceLower,
      priceUpper: range.priceUpper,
      currentPrice,
      inRange,
      liquidityUtilization,
    };
  }

  private resolveRange(
    params: IRangeParams,
    currentPrice: number,
  ): { priceLower: number; priceUpper: number } {
    if (
      params.priceLower !== undefined &&
      params.priceUpper !== undefined &&
      params.priceLower < params.priceUpper
    ) {
      return {
        priceLower: params.priceLower,
        priceUpper: params.priceUpper,
      };
    }
    return this.calculateOptimalRange(
      currentPrice,
      params.rangeWidthPercent ?? 10,
      params.targetUtilization,
    );
  }

  private resolveCurrentPrice(params: IRangeParams): number {
    if (
      params.priceLower !== undefined &&
      params.priceUpper !== undefined &&
      params.priceLower < params.priceUpper
    ) {
      return (params.priceLower + params.priceUpper) / 2;
    }
    return 1;
  }

  private createPositionId(
    userId: string,
    poolAddress: string,
    index: number,
  ): string {
    const digest = createHash("sha256")
      .update(`${userId}:${poolAddress}:${index}`)
      .digest("hex")
      .slice(0, 24);
    return `clp_${digest}`;
  }
}
