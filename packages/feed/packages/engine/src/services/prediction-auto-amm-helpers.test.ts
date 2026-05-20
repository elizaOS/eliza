import { describe, expect, it } from 'bun:test';
import { calculateAutoAmmTargetNudge } from './prediction-auto-amm-helpers';

describe('prediction-auto-amm-helpers', () => {
  it('reverts underpriced YES markets back toward 50/50 in neutral regime', () => {
    const targetNudge = calculateAutoAmmTargetNudge({
      currentYesPrice: 0.2,
      signalDirection: 'NEUTRAL',
      signalIntensity: 0,
      signalSensitivity: 1,
      autoAmmNudgeMultiplier: 1,
      neutralReversionMultiplier: 1,
    });

    expect(targetNudge).toBeGreaterThan(0);
  });

  it('reverts overpriced YES markets back toward 50/50 in neutral regime', () => {
    const targetNudge = calculateAutoAmmTargetNudge({
      currentYesPrice: 0.8,
      signalDirection: 'NEUTRAL',
      signalIntensity: 0,
      signalSensitivity: 1,
      autoAmmNudgeMultiplier: 1,
      neutralReversionMultiplier: 1,
    });

    expect(targetNudge).toBeLessThan(0);
  });
});
