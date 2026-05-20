import { PredictionPricing } from '@babylon/core/markets/prediction/client';

export function getPredictionMarketPrices(
  yesShares: number,
  noShares: number
): { yesPrice: number; noPrice: number } {
  return {
    yesPrice: PredictionPricing.getCurrentPrice(yesShares, noShares, 'yes'),
    noPrice: PredictionPricing.getCurrentPrice(yesShares, noShares, 'no'),
  };
}
