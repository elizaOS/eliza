import type { PerpSide } from "./types";

export const MAX_PERP_USER_EXPOSURE = 1_000_000;

export function shouldLiquidate(
  currentPrice: number,
  liquidationPrice: number,
  side: PerpSide,
): boolean {
  if (side === "long") {
    return currentPrice <= liquidationPrice;
  }
  return currentPrice >= liquidationPrice;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function getEffectivePerpLeverage(leverage: unknown): number {
  const numericLeverage = toFiniteNumber(leverage);
  return numericLeverage && numericLeverage > 0 ? numericLeverage : 1;
}

export function getPerpPositionExposure(position: {
  size: unknown;
  leverage: unknown;
}): number | null {
  const numericSize = toFiniteNumber(position.size);
  if (numericSize === null) return null;

  const exposure =
    Math.abs(numericSize) * getEffectivePerpLeverage(position.leverage);
  return Number.isFinite(exposure) ? exposure : null;
}

export function getOpenPerpPositionIntegrityIssue(position: {
  size: unknown;
  leverage: unknown;
}): "invalid_size" | "invalid_exposure" | "exposure_cap_exceeded" | null {
  const numericSize = toFiniteNumber(position.size);
  if (numericSize === null || Math.abs(numericSize) === 0) {
    return "invalid_size";
  }

  const exposure = getPerpPositionExposure(position);
  if (exposure === null || exposure <= 0) {
    return "invalid_exposure";
  }

  if (exposure > MAX_PERP_USER_EXPOSURE) {
    return "exposure_cap_exceeded";
  }

  return null;
}

export function isOpenPerpPositionStateValid(position: {
  size: unknown;
  leverage: unknown;
}): boolean {
  return getOpenPerpPositionIntegrityIssue(position) === null;
}
