import { isOpenPerpPositionStateValid } from '@babylon/core/markets/perps/client';
import { toNumber } from '@babylon/shared';

export { toNumber };

/**
 * Canonical mark-to-market value for an open perpetual position.
 *
 * `size` is the leveraged notional, so we recover posted margin as
 * `abs(size / leverage)` and then add current unrealized PnL.
 */
export function calculatePerpPositionMarketValue(position: {
  leverage: unknown;
  size: unknown;
  unrealizedPnL: unknown;
}): number {
  if (!isOpenPerpPositionStateValid(position)) {
    return 0;
  }

  const size = toNumber(position.size);
  const leverage = toNumber(position.leverage);
  const unrealizedPnL = toNumber(position.unrealizedPnL);
  const effectiveLeverage =
    Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const margin = Math.abs(size / effectiveLeverage);

  return margin + unrealizedPnL;
}
