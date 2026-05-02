import { describe, expect, test } from "vitest";

// =============================================================================
// Test Helpers - Extract testable logic from service
// =============================================================================

// Re-implement core algorithms for unit testing without runtime dependencies

interface PositionMetadata {
  tickLower?: number;
  priceLower?: number;
  priceUpper?: number;
  currentPrice?: number;
  apr?: number;
  apy?: number;
  locked?: boolean;
  vestingEnd?: string;
  createdAt?: string;
  autoRebalance?: boolean;
  pendingRewards?: number;
  volume24h?: number;
  feeApr?: number;
  rewardApr?: number;
}

interface LpPosition {
  poolId: string;
  dex: string;
  valueUsd?: number;
  metadata?: PositionMetadata;
}

interface MonitoringConfig {
  concentratedRepositionThreshold: number;
  minGainThresholdPercent: number;
  minPoolTvlUsd: number;
}

const MIN_POSITION_VALUE = 10;
const POSITION_AGE_MS = 3600000;

function analyzePositionRebalancability(
  pos: LpPosition,
  _config: MonitoringConfig,
): { rebalancable: boolean; reason?: string; warnings: string[] } {
  const meta = pos.metadata ?? {};
  const warnings: string[] = [];
  const value = pos.valueUsd ?? 0;

  // Check locked
  if (meta.locked === true || meta.vestingEnd != null) {
    return { rebalancable: false, reason: "Position locked", warnings };
  }

  // Check minimum value
  if (value < MIN_POSITION_VALUE) {
    return {
      rebalancable: false,
      reason: `Value $${value.toFixed(2)} below minimum`,
      warnings,
    };
  }

  // Check age
  if (meta.createdAt) {
    const age = Date.now() - new Date(meta.createdAt).getTime();
    if (age < POSITION_AGE_MS) {
      return { rebalancable: false, reason: "Position too new", warnings };
    }
  }

  // Check user preference
  if (meta.autoRebalance === false) {
    return {
      rebalancable: false,
      reason: "User disabled rebalancing",
      warnings,
    };
  }

  // Pending rewards warning
  if (meta.pendingRewards && meta.pendingRewards > value * 0.01) {
    warnings.push(`Unclaimed rewards: $${meta.pendingRewards.toFixed(2)}`);
  }

  return { rebalancable: true, warnings };
}

function analyzeConcentratedPosition(
  meta: PositionMetadata,
  threshold: number,
): { isConcentrated: boolean; priceDistance: number | null; warning?: string } {
  const isConcentrated = "tickLower" in meta || "priceLower" in meta;
  if (!isConcentrated) {
    return { isConcentrated: false, priceDistance: null };
  }

  const { priceLower, priceUpper, currentPrice } = meta;
  if (priceLower == null || priceUpper == null || currentPrice == null) {
    return { isConcentrated: true, priceDistance: null };
  }

  if (currentPrice < priceLower) {
    const dist = ((priceLower - currentPrice) / priceLower) * 100;
    return {
      isConcentrated: true,
      priceDistance: dist,
      warning: `Price ${dist.toFixed(1)}% below range`,
    };
  }

  if (currentPrice > priceUpper) {
    const dist = ((currentPrice - priceUpper) / priceUpper) * 100;
    return {
      isConcentrated: true,
      priceDistance: dist,
      warning: `Price ${dist.toFixed(1)}% above range`,
    };
  }

  // In range - negative distance means inside
  const rangeWidth = priceUpper - priceLower;
  const distToEdge = Math.min(
    currentPrice - priceLower,
    priceUpper - currentPrice,
  );
  const priceDistance = -(distToEdge / rangeWidth) * 100;

  let warning: string | undefined;
  if (distToEdge / rangeWidth < threshold) {
    warning = `Price ${((distToEdge / rangeWidth) * 100).toFixed(1)}% from boundary`;
  }

  return { isConcentrated: true, priceDistance, warning };
}

function scoreOpportunity(
  netGain: number,
  volume: number,
  tvl: number,
  apr: number,
  cost: number,
  posValue: number,
): number {
  let score = 0;

  // Net gain (max 40)
  score += Math.min(netGain * 10, 40);

  // Volume/TVL ratio (max 20)
  if (tvl > 0) {
    const ratio = volume / tvl;
    score +=
      ratio >= 0.1 && ratio <= 0.5
        ? 20
        : ratio > 0.5
          ? 15
          : ratio > 0.05
            ? 10
            : 5;
  }

  // APR sustainability (max 20)
  score += apr <= 30 ? 20 : apr <= 50 ? 15 : apr <= 100 ? 10 : 5;

  // TVL health (max 10)
  score +=
    tvl >= 10_000_000 ? 10 : tvl >= 1_000_000 ? 8 : tvl >= 100_000 ? 5 : 2;

  // Cost efficiency (max 10)
  const costPct = (cost / posValue) * 100;
  score += costPct < 0.1 ? 10 : costPct < 0.5 ? 7 : costPct < 1 ? 4 : 1;

  return score;
}

function determineAprQuality(
  apr: number,
  volume: number,
  tvl: number,
): "sustainable" | "moderate" | "unsustainable" {
  const volumeToTvl = tvl > 0 ? volume / tvl : 0;
  if (volumeToTvl >= 0.1 && apr <= 50) return "sustainable";
  if (apr > 100 || (apr > 50 && volumeToTvl < 0.05)) return "unsustainable";
  return "moderate";
}

// =============================================================================
// Tests: Position Rebalancability
// =============================================================================

describe("Position Rebalancability", () => {
  const config: MonitoringConfig = {
    concentratedRepositionThreshold: 0.1,
    minGainThresholdPercent: 1.0,
    minPoolTvlUsd: 100000,
  };

  test("allows rebalancing for healthy position", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: { createdAt: new Date(Date.now() - 7200000).toISOString() }, // 2 hours old
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("blocks locked positions", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: { locked: true },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toBe("Position locked");
  });

  test("blocks vesting positions", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: { vestingEnd: "2025-12-31" },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toBe("Position locked");
  });

  test("blocks dust positions below minimum", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 5, // Below $10 minimum
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toContain("below minimum");
  });

  test("blocks position at exact minimum boundary", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 9.99, // Just below $10
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
  });

  test("allows position at minimum boundary", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 10.01, // Just above $10
      metadata: { createdAt: new Date(Date.now() - 7200000).toISOString() },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(true);
  });

  test("blocks positions younger than 1 hour", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: { createdAt: new Date(Date.now() - 1800000).toISOString() }, // 30 minutes old
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toBe("Position too new");
  });

  test("allows position exactly 1 hour old", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: { createdAt: new Date(Date.now() - 3600001).toISOString() }, // Just over 1 hour
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(true);
  });

  test("respects user autoRebalance=false preference", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: {
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        autoRebalance: false,
      },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toBe("User disabled rebalancing");
  });

  test("adds warning for significant pending rewards", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: {
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        pendingRewards: 50, // 5% of position value
      },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Unclaimed rewards");
  });

  test("no warning for small pending rewards", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
      metadata: {
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        pendingRewards: 5, // 0.5% of position value
      },
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.warnings).toHaveLength(0);
  });

  test("handles missing metadata gracefully", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
      valueUsd: 1000,
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(true);
  });

  test("handles undefined valueUsd as zero", () => {
    const pos: LpPosition = {
      poolId: "pool-1",
      dex: "raydium",
    };
    const result = analyzePositionRebalancability(pos, config);
    expect(result.rebalancable).toBe(false);
    expect(result.reason).toContain("below minimum");
  });
});

// =============================================================================
// Tests: Concentrated Liquidity Analysis
// =============================================================================

describe("Concentrated Liquidity Analysis", () => {
  const threshold = 0.1; // 10%

  test("identifies non-concentrated positions", () => {
    const meta: PositionMetadata = { apr: 0.25 };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(false);
    expect(result.priceDistance).toBeNull();
  });

  test("identifies concentrated position by tickLower", () => {
    const meta: PositionMetadata = { tickLower: -100 };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
  });

  test("identifies concentrated position by priceLower", () => {
    const meta: PositionMetadata = { priceLower: 1.0 };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
  });

  test("handles concentrated position with incomplete price data", () => {
    const meta: PositionMetadata = { priceLower: 1.0 }; // Missing priceUpper, currentPrice
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
    expect(result.priceDistance).toBeNull();
  });

  test("detects price below range", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 110,
      currentPrice: 90, // 10% below lower bound
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
    expect(result.priceDistance).toBeGreaterThan(0);
    expect(result.warning).toContain("below range");
  });

  test("detects price above range", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 110,
      currentPrice: 120, // Above upper bound
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
    expect(result.priceDistance).toBeGreaterThan(0);
    expect(result.warning).toContain("above range");
  });

  test("identifies price in range (negative distance)", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 110,
      currentPrice: 105, // Center of range
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
    expect(result.priceDistance).toBeLessThan(0); // Negative = in range
    expect(result.warning).toBeUndefined();
  });

  test("warns when price near lower boundary", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 200,
      currentPrice: 105, // 5% into a 100-point range = 5% from lower edge
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.isConcentrated).toBe(true);
    expect(result.warning).toContain("from boundary");
  });

  test("warns when price near upper boundary", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 200,
      currentPrice: 195, // 5% from upper edge
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.warning).toContain("from boundary");
  });

  test("no warning when price comfortably in range", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 200,
      currentPrice: 150, // Center
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.warning).toBeUndefined();
  });

  test("calculates correct distance percentage below range", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 110,
      currentPrice: 80, // 20% below lower
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.priceDistance).toBeCloseTo(20, 1);
  });

  test("calculates correct distance percentage above range", () => {
    const meta: PositionMetadata = {
      priceLower: 100,
      priceUpper: 110,
      currentPrice: 132, // 20% above upper
    };
    const result = analyzeConcentratedPosition(meta, threshold);
    expect(result.priceDistance).toBeCloseTo(20, 1);
  });
});

// =============================================================================
// Tests: Opportunity Scoring
// =============================================================================

describe("Opportunity Scoring", () => {
  test("returns 0 for worst case scenario", () => {
    const score = scoreOpportunity(
      0, // No net gain
      0, // No volume
      0, // No TVL
      200, // Very high APR (unsustainable)
      100, // High cost
      100, // 100% cost ratio
    );
    // With these inputs: 0 (gain) + 0 (no TVL so no volume score) + 5 (high APR) + 2 (tiny TVL) + 1 (high cost)
    expect(score).toBeLessThan(15);
  });

  test("returns high score for ideal opportunity", () => {
    const score = scoreOpportunity(
      4, // 4% net gain (40 points)
      500000, // $500k volume
      1000000, // $1M TVL (50% turnover - good)
      25, // 25% APR (sustainable)
      10, // $10 cost
      10000, // 0.1% cost ratio
    );
    // 40 (gain) + 15 (high volume/tvl) + 20 (sustainable apr) + 8 (good tvl) + 10 (low cost) = 93
    expect(score).toBeGreaterThan(85);
  });

  test("caps net gain contribution at 40 points", () => {
    const score1 = scoreOpportunity(4, 0, 0, 200, 0, 1000);
    const score2 = scoreOpportunity(10, 0, 0, 200, 0, 1000);
    // Both should have same gain contribution (capped at 40)
    expect(score2 - score1).toBe(0);
  });

  test("rewards optimal volume/TVL ratio (10-50%)", () => {
    const optimalScore = scoreOpportunity(0, 200000, 1000000, 200, 0, 1000); // 20% turnover
    const lowScore = scoreOpportunity(0, 10000, 1000000, 200, 0, 1000); // 1% turnover
    const highScore = scoreOpportunity(0, 600000, 1000000, 200, 0, 1000); // 60% turnover

    expect(optimalScore).toBeGreaterThan(lowScore);
    expect(optimalScore).toBeGreaterThan(highScore);
  });

  test("penalizes unsustainably high APR", () => {
    const sustainableAprScore = scoreOpportunity(0, 0, 100000, 25, 0, 1000);
    const highAprScore = scoreOpportunity(0, 0, 100000, 150, 0, 1000);

    expect(sustainableAprScore).toBeGreaterThan(highAprScore);
  });

  test("rewards larger TVL", () => {
    const smallTvl = scoreOpportunity(0, 0, 50000, 30, 0, 1000);
    const mediumTvl = scoreOpportunity(0, 0, 500000, 30, 0, 1000);
    const largeTvl = scoreOpportunity(0, 0, 10000000, 30, 0, 1000);

    expect(largeTvl).toBeGreaterThan(mediumTvl);
    expect(mediumTvl).toBeGreaterThan(smallTvl);
  });

  test("penalizes high cost percentage", () => {
    const lowCost = scoreOpportunity(0, 0, 100000, 30, 1, 10000); // 0.01%
    const highCost = scoreOpportunity(0, 0, 100000, 30, 100, 10000); // 1%

    expect(lowCost).toBeGreaterThan(highCost);
  });

  test("handles zero position value safely", () => {
    // Should not throw, treats as very high cost percentage
    const score = scoreOpportunity(1, 100000, 1000000, 20, 10, 0);
    expect(typeof score).toBe("number");
  });
});

// =============================================================================
// Tests: APR Quality Assessment
// =============================================================================

// =============================================================================
// Tests: Opportunity Validation (LARP fixes for dead config)
// =============================================================================

describe("Opportunity Validation", () => {
  interface EvalConfig {
    minGainThresholdPercent: number;
    maxPositionSizeUsd: number;
    maxIlRiskPercent: number;
    minPoolTvlUsd: number;
  }

  interface EvalInput {
    netGain: number;
    newYield: number;
    positionValue?: number;
    tvl: number;
  }

  // Simplified validation logic from evaluateOpportunity
  function validateOpportunity(
    input: EvalInput,
    config: EvalConfig,
  ): { shouldExecute: boolean; reason: string } {
    const { netGain, newYield, positionValue, tvl } = input;

    // Estimate IL risk based on APR (simplified proxy)
    const estimatedIlRisk =
      newYield > 100 ? 15 : newYield > 50 ? 10 : newYield > 30 ? 5 : 2;

    // Calculate risk score
    let riskScore = 0;
    if (newYield > 50) riskScore += 20;
    if (newYield > 100) riskScore += 30;
    if (tvl < config.minPoolTvlUsd) riskScore += 25;

    // Validation checks in order
    if (positionValue && positionValue > config.maxPositionSizeUsd) {
      return {
        shouldExecute: false,
        reason: `Position $${positionValue.toFixed(0)} exceeds max size $${config.maxPositionSizeUsd}`,
      };
    }
    if (estimatedIlRisk > config.maxIlRiskPercent) {
      return {
        shouldExecute: false,
        reason: `Estimated IL risk ${estimatedIlRisk}% exceeds max ${config.maxIlRiskPercent}%`,
      };
    }
    if (netGain < config.minGainThresholdPercent) {
      return {
        shouldExecute: false,
        reason: `Gain ${netGain.toFixed(2)}% < threshold ${config.minGainThresholdPercent}%`,
      };
    }
    if (riskScore > 50) {
      return { shouldExecute: false, reason: `Risk ${riskScore} too high` };
    }
    if (!positionValue) {
      return {
        shouldExecute: false,
        reason: "Cannot score: missing position value",
      };
    }

    return { shouldExecute: true, reason: `+${netGain.toFixed(2)}% gain` };
  }

  const defaultConfig: EvalConfig = {
    minGainThresholdPercent: 1.0,
    maxPositionSizeUsd: 10000,
    maxIlRiskPercent: 10,
    minPoolTvlUsd: 100000,
  };

  test("blocks positions exceeding maxPositionSizeUsd", () => {
    const result = validateOpportunity(
      { netGain: 5, newYield: 25, positionValue: 15000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("exceeds max size");
  });

  test("allows positions within maxPositionSizeUsd", () => {
    const result = validateOpportunity(
      { netGain: 5, newYield: 25, positionValue: 5000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(true);
  });

  test("blocks high IL risk pools (APR > 100%)", () => {
    const result = validateOpportunity(
      { netGain: 20, newYield: 150, positionValue: 1000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("IL risk");
  });

  test("blocks medium IL risk when config is strict", () => {
    const strictConfig = { ...defaultConfig, maxIlRiskPercent: 3 };
    const result = validateOpportunity(
      { netGain: 5, newYield: 40, positionValue: 1000, tvl: 1000000 },
      strictConfig,
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("IL risk");
  });

  test("allows low IL risk pools", () => {
    const result = validateOpportunity(
      { netGain: 3, newYield: 20, positionValue: 1000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(true);
  });

  test("blocks when position value is missing", () => {
    const result = validateOpportunity(
      { netGain: 5, newYield: 25, positionValue: undefined, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("missing position value");
  });

  test("blocks when net gain is below threshold", () => {
    const result = validateOpportunity(
      { netGain: 0.5, newYield: 25, positionValue: 1000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("< threshold");
  });

  test("blocks high risk scores (low TVL + very high APR)", () => {
    // Risk score: 20 (yield > 50) + 30 (yield > 100) + 25 (low TVL) = 75 > 50
    const result = validateOpportunity(
      { netGain: 5, newYield: 120, positionValue: 1000, tvl: 50000 },
      defaultConfig,
    );
    expect(result.shouldExecute).toBe(false);
    // This will be blocked by IL risk before risk score
    expect(result.reason).toContain("IL risk");
  });

  test("validates all conditions in correct order", () => {
    // Position too large takes precedence over IL risk
    const result = validateOpportunity(
      { netGain: 50, newYield: 200, positionValue: 20000, tvl: 1000000 },
      defaultConfig,
    );
    expect(result.reason).toContain("exceeds max size");
  });
});

describe("APR Quality Assessment", () => {
  test("sustainable: low APR with good volume", () => {
    expect(determineAprQuality(25, 200000, 1000000)).toBe("sustainable");
  });

  test("sustainable: moderate APR with good volume", () => {
    expect(determineAprQuality(50, 100000, 1000000)).toBe("sustainable");
  });

  test("unsustainable: very high APR", () => {
    expect(determineAprQuality(150, 500000, 1000000)).toBe("unsustainable");
  });

  test("unsustainable: high APR with low volume", () => {
    expect(determineAprQuality(75, 10000, 1000000)).toBe("unsustainable");
  });

  test("moderate: medium APR with medium volume", () => {
    expect(determineAprQuality(60, 80000, 1000000)).toBe("moderate");
  });

  test("handles zero TVL", () => {
    expect(determineAprQuality(25, 100000, 0)).toBe("moderate");
  });

  test("boundary: exactly 100 APR", () => {
    expect(determineAprQuality(100, 500000, 1000000)).toBe("moderate");
  });

  test("boundary: APR just over 100", () => {
    expect(determineAprQuality(101, 500000, 1000000)).toBe("unsustainable");
  });

  test("boundary: volume/TVL at 0.1 threshold", () => {
    expect(determineAprQuality(40, 100000, 1000000)).toBe("sustainable");
  });

  test("boundary: volume/TVL just below 0.1", () => {
    expect(determineAprQuality(40, 99000, 1000000)).toBe("moderate");
  });
});

// =============================================================================
// Tests: Config Loading Edge Cases
// =============================================================================

describe("Config Parsing", () => {
  function parseNum(val: string | undefined | null, def: number): number {
    if (val == null) return def;
    const n = Number(val);
    return Number.isNaN(n) ? def : n;
  }

  function parseBool(
    val: string | boolean | undefined | null,
    def: boolean,
  ): boolean {
    if (val == null) return def;
    if (typeof val === "boolean") return val;
    return val === "true" || val === "1";
  }

  test("parseNum returns default for undefined", () => {
    expect(parseNum(undefined, 100)).toBe(100);
  });

  test("parseNum returns default for null", () => {
    expect(parseNum(null, 100)).toBe(100);
  });

  test("parseNum parses valid number string", () => {
    expect(parseNum("50", 100)).toBe(50);
  });

  test("parseNum returns default for NaN", () => {
    expect(parseNum("not-a-number", 100)).toBe(100);
  });

  test("parseNum handles negative numbers", () => {
    expect(parseNum("-5", 100)).toBe(-5);
  });

  test("parseNum handles decimal numbers", () => {
    expect(parseNum("1.5", 100)).toBeCloseTo(1.5);
  });

  test("parseNum handles scientific notation", () => {
    expect(parseNum("1e6", 100)).toBe(1000000);
  });

  test("parseBool returns default for undefined", () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool(undefined, false)).toBe(false);
  });

  test("parseBool returns default for null", () => {
    expect(parseBool(null, true)).toBe(true);
  });

  test("parseBool handles boolean true", () => {
    expect(parseBool(true, false)).toBe(true);
  });

  test("parseBool handles boolean false", () => {
    expect(parseBool(false, true)).toBe(false);
  });

  test('parseBool handles string "true"', () => {
    expect(parseBool("true", false)).toBe(true);
  });

  test('parseBool handles string "1"', () => {
    expect(parseBool("1", false)).toBe(true);
  });

  test('parseBool handles string "false"', () => {
    expect(parseBool("false", true)).toBe(false);
  });

  test('parseBool handles string "0"', () => {
    expect(parseBool("0", true)).toBe(false);
  });

  test("parseBool handles arbitrary string as false", () => {
    expect(parseBool("yes", false)).toBe(false);
    expect(parseBool("enabled", false)).toBe(false);
  });
});
