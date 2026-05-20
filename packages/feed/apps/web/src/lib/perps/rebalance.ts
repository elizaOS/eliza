import type { PerpPosition } from '@feed/shared';
import type { TradeSide } from '@/types/markets';

export type PerpRebalanceType = 'add' | 'reduce' | 'close' | 'flip';

export interface PerpRebalanceInfo {
  type: PerpRebalanceType;
  newSize: number;
}

export function getPerpRebalanceInfo(params: {
  existingPosition: Pick<PerpPosition, 'side' | 'size'> | null;
  nextSide: TradeSide;
  requestedSize: number;
}): PerpRebalanceInfo | null {
  const { existingPosition, nextSide, requestedSize } = params;
  if (!existingPosition || requestedSize <= 0) {
    return null;
  }

  if (existingPosition.side === nextSide) {
    return {
      type: 'add',
      newSize: existingPosition.size + requestedSize,
    };
  }

  if (requestedSize < existingPosition.size) {
    return {
      type: 'reduce',
      newSize: existingPosition.size - requestedSize,
    };
  }

  if (Math.abs(requestedSize - existingPosition.size) < 0.01) {
    return {
      type: 'close',
      newSize: 0,
    };
  }

  return {
    type: 'flip',
    newSize: requestedSize - existingPosition.size,
  };
}

export function shouldApplyPerpBalanceGate(
  rebalanceInfo: PerpRebalanceInfo | null
): boolean {
  if (!rebalanceInfo) return true;
  // Both 'add' and 'flip' may require additional capital.
  // Only 'reduce' and 'close' are guaranteed not to need new funds.
  return rebalanceInfo.type === 'add' || rebalanceInfo.type === 'flip';
}
