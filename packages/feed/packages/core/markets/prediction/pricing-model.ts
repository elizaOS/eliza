/**
 * Prediction Market Pricing Model Interface
 *
 * Abstracts pricing calculation for Babylon's offchain prediction markets.
 *
 * Implementations:
 * - PredictionPricing (CPMM) — algebraic market maker used by the product
 */

export interface PredictionPricingModel {
  /**
   * Get the current price for a side (0-1 range, where 1 = certain).
   */
  getCurrentPrice(
    yesShares: number,
    noShares: number,
    side: 'yes' | 'no'
  ): number;

  /**
   * Calculate shares received for a given USD amount.
   */
  calculateBuy(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    amount: number
  ): {
    sharesBought: number;
    avgPrice: number;
    newYesPrice: number;
    newNoPrice: number;
    priceImpact: number;
  };

  /**
   * Calculate USD received for selling a given number of shares.
   */
  calculateSell(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    shares: number
  ): {
    proceeds: number;
    avgPrice: number;
    newYesPrice: number;
    newNoPrice: number;
    priceImpact: number;
  };
}
