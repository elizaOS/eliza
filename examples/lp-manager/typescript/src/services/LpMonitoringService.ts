import { type IAgentRuntime, logger, Service } from "@elizaos/core";

// =============================================================================
// Type Definitions (mirrors @elizaos/plugin-lp-manager)
// =============================================================================

interface TokenBalance {
  address: string;
  symbol?: string;
  decimals: number;
  balance: string;
  uiAmount?: number;
}

interface LpPositionDetails {
  poolId: string;
  dex: string;
  lpTokenBalance: TokenBalance;
  underlyingTokens: TokenBalance[];
  valueUsd?: number;
  metadata?: Record<string, unknown>;
}

interface PoolInfo {
  id: string;
  dex: string;
  tokenA: { mint: string; symbol?: string; decimals: number };
  tokenB: { mint: string; symbol?: string; decimals: number };
  tvl?: number;
  apr?: number;
  apy?: number;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

interface OptimizationOpportunity {
  sourcePosition?: LpPositionDetails;
  targetPool: PoolInfo;
  estimatedNewYield?: number;
  currentYield?: number;
  estimatedCostToMoveUsd?: number;
  netGainPercent?: number;
}

interface UserLpProfile {
  userId: string;
  vaultPublicKey: string;
  encryptedSecretKey: string;
  autoRebalanceConfig: {
    enabled: boolean;
    minGainThresholdPercent: number;
    preferredDexes?: string[];
    maxSlippageBps: number;
  };
}

interface TransactionResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  tokensReceived?: TokenBalance[];
}

// Service interfaces
interface DexInteractionService {
  getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]>;
  addLiquidity(config: {
    userVault: unknown;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    dexName: string;
    slippageBps: number;
  }): Promise<TransactionResult>;
  removeLiquidity(config: {
    userVault: unknown;
    lpTokenAmountLamports: string;
    poolId: string;
    dexName: string;
    slippageBps: number;
  }): Promise<TransactionResult>;
}

interface UserLpProfileService {
  getProfile(userId: string): Promise<UserLpProfile | null>;
  addTrackedPosition(
    userId: string,
    position: {
      positionIdentifier: string;
      dex: string;
      poolAddress: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  removeTrackedPosition(
    userId: string,
    positionIdentifier: string,
  ): Promise<unknown>;
}

interface YieldOptimizationService {
  findBestYieldOpportunities(
    userId: string,
    positions: LpPositionDetails[],
    idleAssets: TokenBalance[],
  ): Promise<OptimizationOpportunity[]>;
}

interface VaultService {
  getBalances(publicKey: string): Promise<TokenBalance[]>;
  getVaultKeypair(userId: string, encryptedSecretKey: string): Promise<unknown>;
}

// =============================================================================
// Monitoring Types
// =============================================================================

interface MonitoredPosition {
  position: LpPositionDetails;
  lastCheckedAt: number;
  isConcentrated: boolean;
  priceDistanceFromRange: number | null;
  currentApr: number;
  warnings: string[];
  rebalancable: boolean;
  rebalanceBlockedReason?: string;
  volume24h?: number;
  feeApr?: number;
  rewardApr?: number;
}

interface OpportunityAnalysis {
  opportunity: OptimizationOpportunity;
  shouldExecute: boolean;
  reason: string;
  estimatedNetGain: number;
  riskScore: number;
  opportunityScore: number;
  isHighAprOpportunity: boolean;
  aprQuality: "sustainable" | "moderate" | "unsustainable";
}

interface RebalanceResult {
  success: boolean;
  fromPool: string;
  toPool: string;
  previousApr: number;
  newApr: number;
  transactionIds: string[];
  error?: string;
  executedAt: number;
}

export interface LpMonitoringConfig {
  checkIntervalMs: number;
  minGainThresholdPercent: number;
  maxSlippageBps: number;
  autoRebalanceEnabled: boolean;
  concentratedRepositionThreshold: number;
  maxPositionSizeUsd: number;
  minPoolTvlUsd: number;
  maxIlRiskPercent: number;
}

export interface LpMonitoringStatus {
  isMonitoring: boolean;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  totalPositions: number;
  totalValueUsd: number;
  positionsInRange: number;
  positionsOutOfRange: number;
  pendingOpportunities: number;
  recentRebalances: RebalanceResult[];
  config: LpMonitoringConfig;
}

// =============================================================================
// Constants
// =============================================================================

const SERVICE_NAMES = {
  DEX: "dex-interaction",
  PROFILE: "UserLpProfileService",
  YIELD: "YieldOptimizationService",
  VAULT: "VaultService",
} as const;

const DEFAULTS = {
  CHECK_INTERVAL_MS: 300000,
  MIN_GAIN_PERCENT: 1.0,
  MAX_SLIPPAGE_BPS: 50,
  REPOSITION_THRESHOLD: 0.1,
  MAX_POSITION_USD: 10000,
  MIN_POOL_TVL_USD: 100000,
  MAX_IL_RISK_PERCENT: 10,
  MIN_POSITION_VALUE_USD: 10,
  POSITION_AGE_MS: 3600000,
  MAX_RECENT_REBALANCES: 20,
} as const;

// =============================================================================
// LpMonitoringService
// =============================================================================

export class LpMonitoringService extends Service {
  public static readonly serviceType = "LpMonitoringService";
  public readonly capabilityDescription =
    "Autonomous LP position monitoring and rebalancing";

  private dexService: DexInteractionService | null = null;
  private userProfileService: UserLpProfileService | null = null;
  private yieldService: YieldOptimizationService | null = null;
  private vaultService: VaultService | null = null;

  private isMonitoring = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastCheckAt: number | null = null;
  private monitoredPositions = new Map<string, MonitoredPosition>();
  private pendingOpportunities: OpportunityAnalysis[] = [];
  private recentRebalances: RebalanceResult[] = [];
  private cfg: LpMonitoringConfig;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.cfg = this.loadConfig();
  }

  private loadConfig(): LpMonitoringConfig {
    const num = (key: string, def: number) => {
      const v = this.runtime.getSetting(key);
      return v != null && !Number.isNaN(Number(v)) ? Number(v) : def;
    };
    const bool = (key: string, def: boolean) => {
      const v = this.runtime.getSetting(key);
      return v == null ? def : v === "true" || v === "1" || v === true;
    };

    return {
      checkIntervalMs: num("LP_CHECK_INTERVAL_MS", DEFAULTS.CHECK_INTERVAL_MS),
      minGainThresholdPercent: num(
        "LP_MIN_GAIN_THRESHOLD_PERCENT",
        DEFAULTS.MIN_GAIN_PERCENT,
      ),
      maxSlippageBps: num("LP_MAX_SLIPPAGE_BPS", DEFAULTS.MAX_SLIPPAGE_BPS),
      autoRebalanceEnabled: bool("LP_AUTO_REBALANCE_ENABLED", true),
      concentratedRepositionThreshold: num(
        "LP_CONCENTRATED_REPOSITION_THRESHOLD",
        DEFAULTS.REPOSITION_THRESHOLD,
      ),
      maxPositionSizeUsd: num(
        "LP_MAX_POSITION_SIZE_USD",
        DEFAULTS.MAX_POSITION_USD,
      ),
      minPoolTvlUsd: num("LP_MIN_POOL_TVL_USD", DEFAULTS.MIN_POOL_TVL_USD),
      maxIlRiskPercent: num(
        "LP_MAX_IL_RISK_PERCENT",
        DEFAULTS.MAX_IL_RISK_PERCENT,
      ),
    };
  }

  public static async start(
    runtime: IAgentRuntime,
  ): Promise<LpMonitoringService> {
    const instance = new LpMonitoringService(runtime);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    await this.acquireServices();
    logger.info(
      `[LpMonitor] Initialized: interval=${this.cfg.checkIntervalMs}ms, threshold=${this.cfg.minGainThresholdPercent}%, auto=${this.cfg.autoRebalanceEnabled}`,
    );
  }

  private async acquireServices(): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      this.dexService = this.runtime.getService(
        SERVICE_NAMES.DEX,
      ) as DexInteractionService | null;
      this.userProfileService = this.runtime.getService(
        SERVICE_NAMES.PROFILE,
      ) as UserLpProfileService | null;
      this.yieldService = this.runtime.getService(
        SERVICE_NAMES.YIELD,
      ) as YieldOptimizationService | null;
      this.vaultService = this.runtime.getService(
        SERVICE_NAMES.VAULT,
      ) as VaultService | null;

      if (
        this.dexService &&
        this.userProfileService &&
        this.yieldService &&
        this.vaultService
      ) {
        logger.info("[LpMonitor] Services acquired");
        return true;
      }
      logger.info(`[LpMonitor] Waiting for services (${i + 1}/10)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    logger.warn("[LpMonitor] Some services unavailable");
    return false;
  }

  private hasServices(): boolean {
    return !!(
      this.dexService &&
      this.userProfileService &&
      this.yieldService &&
      this.vaultService
    );
  }

  public async stop(): Promise<void> {
    await this.stopMonitoring();
  }

  public async startMonitoring(userId: string): Promise<void> {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    logger.info(
      `[LpMonitor] Starting for user ${userId}, interval=${this.cfg.checkIntervalMs / 60000}min`,
    );

    await this.runCycle(userId);
    this.monitoringInterval = setInterval(
      () =>
        this.runCycle(userId).catch((e) =>
          logger.error("[LpMonitor] Cycle error:", e),
        ),
      this.cfg.checkIntervalMs,
    );
  }

  public async stopMonitoring(): Promise<void> {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    logger.info("[LpMonitor] Stopped");
  }

  private async runCycle(userId: string): Promise<void> {
    if (!this.isMonitoring) return;
    if (!this.hasServices() && !(await this.acquireServices())) return;

    const start = Date.now();
    logger.info(`[LpMonitor] Cycle started`);

    const positions = await this.fetchPositions(userId);
    const outOfRange = positions.filter(
      (p) => p.isConcentrated && (p.priceDistanceFromRange ?? 0) > 0,
    );
    if (outOfRange.length) {
      logger.warn(`[LpMonitor] ${outOfRange.length} positions out of range`);
    }

    this.pendingOpportunities = await this.findOpportunities(userId, positions);
    logger.info(
      `[LpMonitor] Found ${this.pendingOpportunities.length} opportunities`,
    );

    if (this.cfg.autoRebalanceEnabled) {
      await this.executeApprovedRebalances(userId);
    }

    this.lastCheckAt = Date.now();
    logger.info(`[LpMonitor] Cycle completed in ${this.lastCheckAt - start}ms`);
  }

  private async fetchPositions(userId: string): Promise<MonitoredPosition[]> {
    if (!this.dexService) return [];
    const raw = await this.dexService.getAllUserLpPositions(userId);
    const positions = raw.map((p) => this.analyzePosition(p));
    for (const p of positions) {
      this.monitoredPositions.set(p.position.poolId, p);
    }
    return positions;
  }

  private analyzePosition(pos: LpPositionDetails): MonitoredPosition {
    const meta = pos.metadata ?? {};
    const warnings: string[] = [];
    let rebalancable = true;
    let rebalanceBlockedReason: string | undefined;

    // Concentrated liquidity analysis
    const isConcentrated = "tickLower" in meta || "priceLower" in meta;
    let priceDistanceFromRange: number | null = null;

    if (isConcentrated) {
      const { priceLower, priceUpper, currentPrice } = meta as {
        priceLower?: number;
        priceUpper?: number;
        currentPrice?: number;
      };
      if (priceLower != null && priceUpper != null && currentPrice != null) {
        if (currentPrice < priceLower) {
          priceDistanceFromRange =
            ((priceLower - currentPrice) / priceLower) * 100;
          warnings.push(
            `Price ${priceDistanceFromRange.toFixed(1)}% below range`,
          );
        } else if (currentPrice > priceUpper) {
          priceDistanceFromRange =
            ((currentPrice - priceUpper) / priceUpper) * 100;
          warnings.push(
            `Price ${priceDistanceFromRange.toFixed(1)}% above range`,
          );
        } else {
          const rangeWidth = priceUpper - priceLower;
          const distToEdge = Math.min(
            currentPrice - priceLower,
            priceUpper - currentPrice,
          );
          priceDistanceFromRange = -(distToEdge / rangeWidth) * 100;
          if (
            distToEdge / rangeWidth <
            this.cfg.concentratedRepositionThreshold
          ) {
            warnings.push(
              `Price ${((distToEdge / rangeWidth) * 100).toFixed(1)}% from boundary`,
            );
          }
        }
      }
    }

    // APR
    const currentApr = (meta.apr as number) ?? (meta.apy as number) ?? 0;
    if (currentApr < this.cfg.minGainThresholdPercent / 100) {
      warnings.push(`Low APR: ${(currentApr * 100).toFixed(1)}%`);
    }

    // Rebalancability checks
    const value = pos.valueUsd ?? 0;
    if (meta.locked === true || meta.vestingEnd != null) {
      rebalancable = false;
      rebalanceBlockedReason = "Position locked";
    } else if (value < DEFAULTS.MIN_POSITION_VALUE_USD) {
      rebalancable = false;
      rebalanceBlockedReason = `Value $${value.toFixed(2)} below minimum`;
    } else if (
      meta.createdAt &&
      Date.now() - new Date(meta.createdAt as string).getTime() <
        DEFAULTS.POSITION_AGE_MS
    ) {
      rebalancable = false;
      rebalanceBlockedReason = "Position too new";
    } else if (meta.autoRebalance === false) {
      rebalancable = false;
      rebalanceBlockedReason = "User disabled rebalancing";
    }

    // Pending rewards warning
    const pendingRewards = meta.pendingRewards as number | undefined;
    if (pendingRewards && pendingRewards > value * 0.01) {
      warnings.push(`Unclaimed rewards: $${pendingRewards.toFixed(2)}`);
    }

    return {
      position: pos,
      lastCheckedAt: Date.now(),
      isConcentrated,
      priceDistanceFromRange,
      currentApr,
      warnings,
      rebalancable,
      rebalanceBlockedReason,
      volume24h: meta.volume24h as number | undefined,
      feeApr: meta.feeApr as number | undefined,
      rewardApr: meta.rewardApr as number | undefined,
    };
  }

  private async findOpportunities(
    userId: string,
    positions: MonitoredPosition[],
  ): Promise<OpportunityAnalysis[]> {
    if (!this.userProfileService || !this.vaultService || !this.yieldService) {
      return [];
    }

    const profile = await this.userProfileService.getProfile(userId);
    if (!profile) {
      logger.warn(
        `[LpMonitor] No profile found for user ${userId}, skipping opportunity analysis`,
      );
      return [];
    }

    const rebalancable = positions.filter((p) => p.rebalancable);
    const balances = await this.vaultService.getBalances(profile.vaultPublicKey);
    const opportunities = await this.yieldService.findBestYieldOpportunities(
      userId,
      rebalancable.map((p) => p.position),
      balances,
    );

    return opportunities
      .map((opp) => this.evaluateOpportunity(opp, profile, positions))
      .sort((a, b) =>
        a.shouldExecute === b.shouldExecute
          ? b.opportunityScore - a.opportunityScore
          : a.shouldExecute
            ? -1
            : 1,
      );
  }

  private evaluateOpportunity(
    opp: OptimizationOpportunity,
    profile: UserLpProfile,
    positions: MonitoredPosition[],
  ): OpportunityAnalysis {
    const netGain = opp.netGainPercent ?? 0;
    const newYield = opp.estimatedNewYield ?? 0;
    const cost = opp.estimatedCostToMoveUsd ?? 0;
    const tvl = opp.targetPool.tvl ?? 0;
    const volume = (opp.targetPool.metadata?.volume24h as number) ?? 0;
    const positionValue = opp.sourcePosition?.valueUsd;

    // Risk score (0-100, lower is better)
    let riskScore = 0;
    if (newYield > 50) riskScore += 20;
    if (newYield > 100) riskScore += 30;
    if (positionValue) {
      const costPct = (cost / positionValue) * 100;
      if (costPct > 1) riskScore += 15;
      if (costPct > 2) riskScore += 15;
    }
    if (tvl < this.cfg.minPoolTvlUsd) riskScore += 25;

    // Estimate IL risk based on token volatility indicators (simplified: use APR as proxy)
    // High APR pools typically have higher volatility pairs
    const estimatedIlRisk =
      newYield > 100 ? 15 : newYield > 50 ? 10 : newYield > 30 ? 5 : 2;

    // Opportunity score - require position value for accurate scoring
    const opportunityScore = positionValue
      ? this.scoreOpportunity(
          netGain,
          volume,
          tvl,
          newYield,
          cost,
          positionValue,
        )
      : 0;

    // APR quality
    const volumeToTvl = tvl > 0 ? volume / tvl : 0;
    let aprQuality: "sustainable" | "moderate" | "unsustainable" = "moderate";
    if (volumeToTvl >= 0.1 && newYield <= 50) aprQuality = "sustainable";
    else if (newYield > 100 || (newYield > 50 && volumeToTvl < 0.05))
      aprQuality = "unsustainable";

    const isHighAprOpportunity =
      newYield >= 20 &&
      aprQuality !== "unsustainable" &&
      tvl >= this.cfg.minPoolTvlUsd;

    // Check source rebalancability
    const srcPos = opp.sourcePosition
      ? positions.find((p) => p.position.poolId === opp.sourcePosition?.poolId)
      : null;
    const srcBlocked = srcPos && !srcPos.rebalancable;

    // Decision with all config validations
    let shouldExecute = false;
    let reason: string;

    if (srcBlocked) {
      reason = `Source locked: ${srcPos?.rebalanceBlockedReason}`;
    } else if (positionValue && positionValue > this.cfg.maxPositionSizeUsd) {
      reason = `Position $${positionValue.toFixed(0)} exceeds max size $${this.cfg.maxPositionSizeUsd}`;
    } else if (estimatedIlRisk > this.cfg.maxIlRiskPercent) {
      reason = `Estimated IL risk ${estimatedIlRisk}% exceeds max ${this.cfg.maxIlRiskPercent}%`;
    } else if (netGain < this.cfg.minGainThresholdPercent) {
      reason = `Gain ${netGain.toFixed(2)}% < threshold ${this.cfg.minGainThresholdPercent}%`;
    } else if (riskScore > 50) {
      reason = `Risk ${riskScore} too high`;
    } else if (
      profile.autoRebalanceConfig.preferredDexes?.length &&
      !profile.autoRebalanceConfig.preferredDexes.includes(opp.targetPool.dex)
    ) {
      reason = `DEX ${opp.targetPool.dex} not preferred`;
    } else if (aprQuality === "unsustainable" && newYield > 100) {
      reason = `APR ${newYield.toFixed(0)}% unsustainable`;
    } else if (!positionValue) {
      reason = "Cannot score: missing position value";
    } else {
      shouldExecute = true;
      reason = `+${netGain.toFixed(2)}% gain${isHighAprOpportunity ? " ⭐" : ""}`;
    }

    return {
      opportunity: opp,
      shouldExecute,
      reason,
      estimatedNetGain: netGain,
      riskScore,
      opportunityScore,
      isHighAprOpportunity,
      aprQuality,
    };
  }

  private scoreOpportunity(
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
    // Volume/TVL (max 20)
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

  private async executeApprovedRebalances(userId: string): Promise<void> {
    const approved = this.pendingOpportunities.filter((o) => o.shouldExecute);
    if (!approved.length) return;

    logger.info(`[LpMonitor] Executing ${approved.length} rebalances`);
    for (const analysis of approved) {
      const result = await this.executeRebalance(userId, analysis);
      this.recentRebalances.push(result);
      if (this.recentRebalances.length > DEFAULTS.MAX_RECENT_REBALANCES) {
        this.recentRebalances.shift();
      }
      logger.info(
        `[LpMonitor] Rebalance ${result.success ? "✓" : "✗"}: ${result.fromPool} → ${result.toPool}`,
      );
    }
  }

  private async executeRebalance(
    userId: string,
    analysis: OpportunityAnalysis,
  ): Promise<RebalanceResult> {
    const { opportunity: opp } = analysis;
    const fromPool = opp.sourcePosition?.poolId ?? "idle";
    const toPool = opp.targetPool.id;
    const prevApr = (opp.currentYield ?? 0) / 100;
    const newApr = (opp.estimatedNewYield ?? 0) / 100;
    const txIds: string[] = [];
    const executedAt = Date.now();

    const baseResult = {
      fromPool,
      toPool,
      previousApr: prevApr,
      newApr,
      transactionIds: txIds,
      executedAt,
    };

    // Check required services
    if (!this.userProfileService || !this.vaultService || !this.dexService) {
      return { success: false, ...baseResult, error: "Services not available" };
    }

    const profile = await this.userProfileService.getProfile(userId);
    if (!profile) {
      logger.warn(
        `[LpMonitor] Rebalance failed: profile not found for user ${userId}`,
      );
      return { success: false, ...baseResult, error: "Profile not found" };
    }

    const keypair = await this.vaultService.getVaultKeypair(
      userId,
      profile.encryptedSecretKey,
    );
    let tokens: TokenBalance[] = [];

    // Withdraw from source
    if (opp.sourcePosition) {
      const result = await this.dexService.removeLiquidity({
        userVault: keypair,
        lpTokenAmountLamports: opp.sourcePosition.lpTokenBalance.balance,
        poolId: opp.sourcePosition.poolId,
        dexName: opp.sourcePosition.dex,
        slippageBps: this.cfg.maxSlippageBps,
      });
      if (!result.success) {
        logger.error(
          `[LpMonitor] Withdraw failed from ${fromPool}: ${result.error}`,
        );
        return {
          success: false,
          ...baseResult,
          transactionIds: txIds,
          error: `Withdraw failed: ${result.error}`,
        };
      }
      if (result.transactionId) txIds.push(result.transactionId);
      tokens = result.tokensReceived ?? opp.sourcePosition.underlyingTokens;
      await this.userProfileService.removeTrackedPosition(
        userId,
        opp.sourcePosition.poolId,
      );
    }

    // Check token compatibility - explicit blocking with detailed error
    const tokenA = tokens.find((t) => t.address === opp.targetPool.tokenA.mint);
    const tokenB = tokens.find((t) => t.address === opp.targetPool.tokenB.mint);
    if (!tokenA || !tokenB) {
      const haveTokens = tokens
        .map((t) => t.symbol ?? t.address.slice(0, 8))
        .join(", ");
      const needTokens = `${opp.targetPool.tokenA.symbol ?? opp.targetPool.tokenA.mint.slice(0, 8)}/${opp.targetPool.tokenB.symbol ?? opp.targetPool.tokenB.mint.slice(0, 8)}`;
      const errorMsg = `Token mismatch: have [${haveTokens}], need [${needTokens}]. Cross-token rebalancing requires a swap (not yet supported).`;
      logger.error(`[LpMonitor] ${errorMsg}`);
      return {
        success: false,
        ...baseResult,
        transactionIds: txIds,
        error: errorMsg,
      };
    }

    // Deposit to target
    const addResult = await this.dexService.addLiquidity({
      userVault: keypair,
      poolId: opp.targetPool.id,
      tokenAAmountLamports: tokenA.balance,
      tokenBAmountLamports: tokenB.balance,
      dexName: opp.targetPool.dex,
      slippageBps: this.cfg.maxSlippageBps,
    });
    if (!addResult.success) {
      logger.error(
        `[LpMonitor] Deposit failed to ${toPool}: ${addResult.error}`,
      );
      return {
        success: false,
        ...baseResult,
        transactionIds: txIds,
        error: `Deposit failed: ${addResult.error}`,
      };
    }
    if (addResult.transactionId) txIds.push(addResult.transactionId);

    await this.userProfileService.addTrackedPosition(userId, {
      positionIdentifier: opp.targetPool.id,
      dex: opp.targetPool.dex,
      poolAddress: opp.targetPool.id,
      metadata: { addedAt: new Date().toISOString(), previousPool: fromPool },
    });

    return { success: true, ...baseResult, transactionIds: txIds };
  }

  // =============================================================================
  // Public API
  // =============================================================================

  public getStatus(): LpMonitoringStatus {
    const positions = Array.from(this.monitoredPositions.values());
    const inRange = positions.filter(
      (p) => !p.isConcentrated || (p.priceDistanceFromRange ?? 0) <= 0,
    ).length;

    return {
      isMonitoring: this.isMonitoring,
      lastCheckAt: this.lastCheckAt,
      nextCheckAt:
        this.isMonitoring && this.lastCheckAt
          ? this.lastCheckAt + this.cfg.checkIntervalMs
          : null,
      totalPositions: positions.length,
      totalValueUsd: positions.reduce(
        (s, p) => s + (p.position.valueUsd ?? 0),
        0,
      ),
      positionsInRange: inRange,
      positionsOutOfRange: positions.length - inRange,
      pendingOpportunities: this.pendingOpportunities.filter(
        (o) => o.shouldExecute,
      ).length,
      recentRebalances: [...this.recentRebalances],
      config: { ...this.cfg },
    };
  }

  public getPositions(): MonitoredPosition[] {
    return Array.from(this.monitoredPositions.values());
  }

  public getOpportunities(): OpportunityAnalysis[] {
    return [...this.pendingOpportunities];
  }

  public updateConfig(updates: Partial<LpMonitoringConfig>): void {
    Object.assign(this.cfg, updates);
    logger.info(`[LpMonitor] Config updated: ${JSON.stringify(updates)}`);
    if (updates.checkIntervalMs && this.isMonitoring) {
      this.stopMonitoring();
      logger.info("[LpMonitor] Restart required for new interval");
    }
  }

  public async triggerCheck(userId: string): Promise<void> {
    await this.runCycle(userId);
  }

  public async triggerRebalance(
    userId: string,
    index: number,
  ): Promise<RebalanceResult | null> {
    if (index < 0 || index >= this.pendingOpportunities.length) {
      logger.warn(
        `[LpMonitor] Invalid opportunity index ${index}, valid range: 0-${this.pendingOpportunities.length - 1}`,
      );
      return null;
    }
    const result = await this.executeRebalance(userId, {
      ...this.pendingOpportunities[index],
      shouldExecute: true,
    });
    this.recentRebalances.push(result);
    return result;
  }
}

export default LpMonitoringService;
