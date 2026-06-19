import type { StaticOrganization } from "./static-data-registry";

export interface MarketSimulationProfile {
  baseVolatility: number;
  jumpChance: number;
  maxTickMove: number;
  trendPersistence: number;
  fairValuePull: number;
  marketBeta: number;
  liquiditySensitivity: number;
  idiosyncraticVolatility: number;
}

export interface MarketSimulationState {
  recentVolatility: number;
  momentum: number;
  lastMove: number;
  latentPrice: number;
}

export interface GlobalMarketSimulationState {
  marketDrift: number;
  volatilityLevel: number;
  riskSentiment: number;
}

const TYPE_PRESETS: Record<
  StaticOrganization["type"],
  MarketSimulationProfile
> = {
  company: {
    baseVolatility: 0.0055,
    jumpChance: 0.012,
    maxTickMove: 0.04,
    trendPersistence: 0.22,
    fairValuePull: 0.28,
    marketBeta: 1,
    liquiditySensitivity: 1,
    idiosyncraticVolatility: 0.0045,
  },
  media: {
    baseVolatility: 0.0075,
    jumpChance: 0.018,
    maxTickMove: 0.05,
    trendPersistence: 0.18,
    fairValuePull: 0.24,
    marketBeta: 1.12,
    liquiditySensitivity: 1.15,
    idiosyncraticVolatility: 0.006,
  },
  government: {
    baseVolatility: 0.004,
    jumpChance: 0.008,
    maxTickMove: 0.03,
    trendPersistence: 0.12,
    fairValuePull: 0.35,
    marketBeta: 0.72,
    liquiditySensitivity: 0.82,
    idiosyncraticVolatility: 0.003,
  },
  vc: {
    baseVolatility: 0.0068,
    jumpChance: 0.016,
    maxTickMove: 0.045,
    trendPersistence: 0.24,
    fairValuePull: 0.22,
    marketBeta: 1.05,
    liquiditySensitivity: 1.08,
    idiosyncraticVolatility: 0.0055,
  },
  organization: {
    baseVolatility: 0.0058,
    jumpChance: 0.011,
    maxTickMove: 0.04,
    trendPersistence: 0.2,
    fairValuePull: 0.26,
    marketBeta: 0.95,
    liquiditySensitivity: 0.95,
    idiosyncraticVolatility: 0.0045,
  },
  financial: {
    baseVolatility: 0.0062,
    jumpChance: 0.013,
    maxTickMove: 0.04,
    trendPersistence: 0.19,
    fairValuePull: 0.3,
    marketBeta: 1.08,
    liquiditySensitivity: 0.88,
    idiosyncraticVolatility: 0.004,
  },
};

const DEFAULT_GLOBAL_STATE: GlobalMarketSimulationState = {
  marketDrift: 0,
  volatilityLevel: 1,
  riskSentiment: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stableUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function sampleShock(rng: () => number): number {
  return rng() - 0.5 + (rng() - 0.5) + (rng() - 0.5) + (rng() - 0.5);
}

export function getDefaultGlobalMarketSimulationState(): GlobalMarketSimulationState {
  return { ...DEFAULT_GLOBAL_STATE };
}

export function evolveGlobalMarketSimulationState(
  state: GlobalMarketSimulationState,
  rng: () => number = Math.random,
): GlobalMarketSimulationState {
  const regimeShift = rng() < 0.03;
  const driftShock = sampleShock(rng) * 0.0015;
  const sentimentShock = sampleShock(rng) * 0.12;
  const volatilityShock = sampleShock(rng) * 0.08;

  return {
    marketDrift: clamp(
      state.marketDrift * (regimeShift ? 0.35 : 0.82) + driftShock,
      -0.01,
      0.01,
    ),
    riskSentiment: clamp(
      state.riskSentiment * (regimeShift ? 0.4 : 0.88) + sentimentShock,
      -1,
      1,
    ),
    volatilityLevel: clamp(
      state.volatilityLevel * (regimeShift ? 0.7 : 0.9) + volatilityShock,
      0.65,
      1.85,
    ),
  };
}

export function buildMarketSimulationProfile(input: {
  organizationId: string;
  ticker: string;
  organization?: Pick<
    StaticOrganization,
    "type" | "name" | "description"
  > | null;
}): MarketSimulationProfile {
  const preset =
    TYPE_PRESETS[input.organization?.type ?? "company"] ?? TYPE_PRESETS.company;
  const seedBase = `${input.organizationId}:${input.ticker}`;
  const volJitter = 0.85 + stableUnit(`${seedBase}:vol`) * 0.4;
  const jumpJitter = 0.8 + stableUnit(`${seedBase}:jump`) * 0.5;
  const betaJitter = 0.9 + stableUnit(`${seedBase}:beta`) * 0.25;
  const liquidityJitter = 0.8 + stableUnit(`${seedBase}:liq`) * 0.5;
  const trendJitter = 0.85 + stableUnit(`${seedBase}:trend`) * 0.35;
  const pullJitter = 0.85 + stableUnit(`${seedBase}:pull`) * 0.35;

  return {
    baseVolatility: preset.baseVolatility * volJitter,
    jumpChance: preset.jumpChance * jumpJitter,
    maxTickMove: preset.maxTickMove,
    trendPersistence: clamp(preset.trendPersistence * trendJitter, 0.08, 0.4),
    fairValuePull: clamp(preset.fairValuePull * pullJitter, 0.12, 0.5),
    marketBeta: clamp(preset.marketBeta * betaJitter, 0.55, 1.35),
    liquiditySensitivity: clamp(
      preset.liquiditySensitivity * liquidityJitter,
      0.55,
      1.5,
    ),
    idiosyncraticVolatility: preset.idiosyncraticVolatility * volJitter,
  };
}

export function createInitialMarketSimulationState(
  currentPrice: number,
  profile: MarketSimulationProfile,
): MarketSimulationState {
  return {
    recentVolatility: profile.baseVolatility,
    momentum: 0,
    lastMove: 0,
    latentPrice: currentPrice,
  };
}

export function generateProfileDrivenMarketMove(params: {
  state: MarketSimulationState;
  profile: MarketSimulationProfile;
  globalState: GlobalMarketSimulationState;
  currentPrice: number;
  openInterest: number;
  rng?: () => number;
}): { move: number; nextState: MarketSimulationState } {
  const rng = params.rng ?? Math.random;
  const { currentPrice, globalState, openInterest, profile, state } = params;

  const openInterestScale = Math.max(1, openInterest / 10_000);
  const liquidityDamping =
    profile.liquiditySensitivity / Math.sqrt(1 + openInterestScale);

  const commonShock =
    (globalState.marketDrift + globalState.riskSentiment * 0.0015) *
    profile.marketBeta;
  const idiosyncraticShock =
    sampleShock(rng) *
    profile.idiosyncraticVolatility *
    globalState.volatilityLevel;
  const latentMove = commonShock + idiosyncraticShock;
  // Evolve fair value independently so dislocations can persist across ticks.
  const latentPrice =
    Number.isFinite(state.latentPrice) && state.latentPrice > 0
      ? state.latentPrice
      : currentPrice;
  const nextLatentPrice = latentPrice * (1 + latentMove);

  const gapToLatent = clamp(
    (nextLatentPrice - currentPrice) / Math.max(currentPrice, 1),
    -profile.maxTickMove,
    profile.maxTickMove,
  );

  let move =
    gapToLatent * profile.fairValuePull +
    state.momentum * profile.trendPersistence +
    sampleShock(rng) *
      state.recentVolatility *
      globalState.volatilityLevel *
      liquidityDamping;

  const jumpChance = clamp(
    profile.jumpChance * globalState.volatilityLevel * (1 + liquidityDamping),
    0,
    0.2,
  );
  if (rng() < jumpChance) {
    const jumpDirection =
      Math.abs(gapToLatent) > 0.0005
        ? Math.sign(gapToLatent)
        : rng() > 0.5
          ? 1
          : -1;
    const jumpMagnitude =
      profile.baseVolatility *
      (2.2 + rng() * 2.6) *
      globalState.volatilityLevel;
    move += jumpDirection * jumpMagnitude;
  }

  if (move < 0) {
    move *= 1.08;
  }

  const clampedMove = clamp(move, -profile.maxTickMove, profile.maxTickMove);

  return {
    move: clampedMove,
    nextState: {
      recentVolatility: clamp(
        state.recentVolatility * 0.78 + Math.abs(clampedMove) * 0.22,
        profile.baseVolatility * 0.75,
        profile.maxTickMove,
      ),
      momentum: clampedMove,
      lastMove: clampedMove,
      latentPrice: nextLatentPrice,
    },
  };
}
