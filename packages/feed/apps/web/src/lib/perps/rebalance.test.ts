import { describe, expect, it } from 'bun:test';
import { getPerpRebalanceInfo, shouldApplyPerpBalanceGate } from './rebalance';

describe('perp rebalance helpers', () => {
  it('returns null when there is no existing position', () => {
    expect(
      getPerpRebalanceInfo({
        existingPosition: null,
        nextSide: 'long',
        requestedSize: 100,
      })
    ).toBeNull();
  });

  it('classifies same-side trades as add', () => {
    expect(
      getPerpRebalanceInfo({
        existingPosition: { side: 'long', size: 100 },
        nextSide: 'long',
        requestedSize: 40,
      })
    ).toEqual({
      type: 'add',
      newSize: 140,
    });
  });

  it('classifies smaller opposite trades as reduce', () => {
    expect(
      getPerpRebalanceInfo({
        existingPosition: { side: 'long', size: 100 },
        nextSide: 'short',
        requestedSize: 40,
      })
    ).toEqual({
      type: 'reduce',
      newSize: 60,
    });
  });

  it('classifies equal opposite trades as close', () => {
    expect(
      getPerpRebalanceInfo({
        existingPosition: { side: 'long', size: 100 },
        nextSide: 'short',
        requestedSize: 100,
      })
    ).toEqual({
      type: 'close',
      newSize: 0,
    });
  });

  it('classifies larger opposite trades as flip', () => {
    expect(
      getPerpRebalanceInfo({
        existingPosition: { side: 'long', size: 100 },
        nextSide: 'short',
        requestedSize: 140,
      })
    ).toEqual({
      type: 'flip',
      newSize: 40,
    });
  });

  it('applies balance gating to fresh opens, add, and flip flows', () => {
    expect(shouldApplyPerpBalanceGate(null)).toBe(true);
    expect(shouldApplyPerpBalanceGate({ type: 'add', newSize: 150 })).toBe(
      true
    );
    expect(shouldApplyPerpBalanceGate({ type: 'reduce', newSize: 50 })).toBe(
      false
    );
    expect(shouldApplyPerpBalanceGate({ type: 'close', newSize: 0 })).toBe(
      false
    );
    expect(shouldApplyPerpBalanceGate({ type: 'flip', newSize: 25 })).toBe(
      true
    );
  });
});
