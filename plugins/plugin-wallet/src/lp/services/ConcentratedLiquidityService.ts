/**
 * ConcentratedLiquidityService exposes the concentrated-liquidity surface while
 * DEX-specific providers add position creation and rebalancing support.
 */
import { type IAgentRuntime, Service } from "@elizaos/core";
import type {
  IConcentratedLiquidityService,
  IConcentratedPosition,
  IRangeParams,
} from "../types";

export class ConcentratedLiquidityService
  extends Service
  implements IConcentratedLiquidityService
{
  public static readonly serviceType = "concentrated-liquidity";
  public readonly capabilityDescription =
    "Manages concentrated liquidity positions with range selection and automated rebalancing";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ConcentratedLiquidityService> {
    const service = new ConcentratedLiquidityService();
    await service.start(runtime);
    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    // No cleanup needed for static stop
  }

  async start(_runtime: IAgentRuntime): Promise<void> {
    // Service initialization
    console.info(
      "ConcentratedLiquidityService started - awaiting DEX integration",
    );
  }

  async stop(): Promise<void> {}

  async createConcentratedPosition(
    _userId: string,
    _params: IRangeParams,
  ): Promise<IConcentratedPosition> {
    throw new Error(
      "Concentrated liquidity positions are coming soon! This feature requires DEX integration.",
    );
  }

  async getConcentratedPositions(
    userId: string,
  ): Promise<IConcentratedPosition[]> {
    console.info(`Getting concentrated positions for user ${userId}`);
    return [];
  }

  async rebalanceConcentratedPosition(
    _userId: string,
    _positionId: string,
    _newRangeParams?: Partial<IRangeParams>,
  ): Promise<IConcentratedPosition> {
    throw new Error("Concentrated position rebalancing is coming soon!");
  }

  /**
   * Calculate optimal price range based on volatility and target utilization
   */
  calculateOptimalRange(
    currentPrice: number,
    rangeWidthPercent: number,
    _targetUtilization: number = 80,
  ): { priceLower: number; priceUpper: number } {
    // Fail loud on degenerate width and price: a non-positive width produces
    // an inverted or zero-width range (priceLower >= priceUpper), which would
    // silently break every downstream in-range/utilization decision. A
    // non-positive price mirrors the range into negative bounds (-100, 20 →
    // lower=-90 > upper=-110) and a width of 200+ drives the lower bound to
    // zero or below, so both are rejected up front.
    if (
      !Number.isFinite(currentPrice) ||
      currentPrice <= 0 ||
      !Number.isFinite(rangeWidthPercent) ||
      rangeWidthPercent <= 0 ||
      rangeWidthPercent >= 200
    ) {
      throw new RangeError(
        "calculateOptimalRange requires a finite positive currentPrice and a rangeWidthPercent in (0, 200)",
      );
    }
    // Simple symmetric range calculation
    const halfWidth = rangeWidthPercent / 2;
    const priceLower = currentPrice * (1 - halfWidth / 100);
    const priceUpper = currentPrice * (1 + halfWidth / 100);

    // Output invariant: the computed range must be finite and positively
    // ordered; overflow on extreme-but-finite inputs fails loud instead of
    // returning an inverted/zero-width range.
    if (
      !Number.isFinite(priceLower) ||
      !Number.isFinite(priceUpper) ||
      priceLower <= 0 ||
      priceLower >= priceUpper
    ) {
      throw new RangeError(
        "calculateOptimalRange produced non-finite or degenerate bounds",
      );
    }

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
    const priceRange = priceUpper - priceLower;
    // Fail loud on a degenerate range: a zero-width or inverted range makes
    // the utilization formula divide by zero (previously surfaced as
    // Infinity clamped to 100 — a silent 100% for a range with no width).
    // Non-finite prices are also rejected here rather than treated as
    // "outside the range" → 0%: NaN/Infinity inputs are programmer errors
    // and would silently under-report utilization as fail-open 0.
    if (
      !Number.isFinite(currentPrice) ||
      !Number.isFinite(priceLower) ||
      !Number.isFinite(priceUpper) ||
      !Number.isFinite(priceRange) ||
      priceRange <= 0
    ) {
      throw new RangeError(
        "calculateUtilization requires finite prices and priceUpper > priceLower",
      );
    }

    if (!this.isPriceInRange(currentPrice, priceLower, priceUpper)) {
      return 0;
    }

    const distanceFromLower = currentPrice - priceLower;
    const distanceFromUpper = priceUpper - currentPrice;

    // Liquidity utilization is highest when price is in the middle of the range
    const utilization =
      (Math.min(distanceFromLower, distanceFromUpper) / (priceRange / 2)) * 100;
    return Math.min(utilization, 100);
  }
}
