/** Base magnitude of auto-AMM price nudges per tick */
export const BASE_NUDGE_PERCENT = 0.02;

/** How strongly prices converge toward 50/50 when no signal */
export const NEUTRAL_REVERSION_RATE = 0.005;

export function calculateAutoAmmTargetNudge(params: {
  currentYesPrice: number;
  signalDirection: 'YES' | 'NO' | 'NEUTRAL';
  signalIntensity: number;
  signalSensitivity: number;
  autoAmmNudgeMultiplier: number;
  neutralReversionMultiplier: number;
}): number {
  if (params.signalDirection !== 'NEUTRAL') {
    const nudge =
      BASE_NUDGE_PERCENT *
      params.signalIntensity *
      params.signalSensitivity *
      params.autoAmmNudgeMultiplier;
    return params.signalDirection === 'YES' ? nudge : -nudge;
  }

  const deviation = params.currentYesPrice - 0.5;
  return (
    -deviation * NEUTRAL_REVERSION_RATE * params.neutralReversionMultiplier
  );
}
