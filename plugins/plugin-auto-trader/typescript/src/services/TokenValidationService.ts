import { type IAgentRuntime, logger, Service } from "@elizaos/core";

/**
 * RugCheck risk levels
 */
export type RiskLevel = "safe" | "warning" | "danger" | "unknown";

/**
 * RugCheck report for a token
 */
export interface RugCheckReport {
  tokenAddress: string;
  riskLevel: RiskLevel;
  score: number;
  risks: TokenRisk[];
  tokenInfo: {
    name: string;
    symbol: string;
    decimals: number;
    supply: string;
    mintAuthority: string | null;
    freezeAuthority: string | null;
  };
  holders: {
    totalHolders: number;
    topHoldersPercent: number;
    top10Holders: Array<{
      address: string;
      percent: number;
      isInsider: boolean;
    }>;
  };
  liquidity: {
    totalLiquidityUsd: number;
    pools: Array<{
      dex: string;
      liquidityUsd: number;
      lpLocked: boolean;
      lpLockPercent: number;
    }>;
  };
  validatedAt: number;
  cacheExpiry: number;
}

/**
 * Individual risk factor
 */
export interface TokenRisk {
  name: string;
  description: string;
  level: RiskLevel;
  score: number;
}

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  report: RugCheckReport | null;
  rejectionReasons: string[];
  warnings: string[];
}

/**
 * Minimum requirements for trading
 */
export interface TradingRequirements {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxTopHoldersPercent: number;
  maxRugPullScore: number;
  requireLpLock: boolean;
  // Honeypot detection
  minSellCount24h: number; // Minimum sell transactions in 24h
  maxBuySellRatio: number; // Max buy/sell ratio (high = honeypot)
  minTokenAgeSeconds: number; // Minimum token age in seconds
  minUniqueTraders24h: number; // Minimum unique traders
}

const DEFAULT_REQUIREMENTS: TradingRequirements = {
  minLiquidityUsd: 50000,
  minVolume24hUsd: 100000,
  maxTopHoldersPercent: 80,
  maxRugPullScore: 30,
  requireLpLock: false,
  // Honeypot detection defaults
  minSellCount24h: 50, // At least 50 sells in 24h
  maxBuySellRatio: 5, // If 5x more buys than sells, suspicious
  minTokenAgeSeconds: 24 * 60 * 60, // At least 24 hours old
  minUniqueTraders24h: 100, // At least 100 unique traders
};

/**
 * Cache duration for RugCheck reports (6 hours)
 */
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;

/**
 * Trading activity data for honeypot detection
 */
export interface TradingActivity {
  volume24h: number;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24h: number;
  sellVolume24h: number;
  uniqueTraders24h: number;
  createdAt: number | null;
  lastTradeAt: number | null;
}

/**
 * TokenValidationService - Validates tokens before trading using RugCheck API
 *
 * This service provides:
 * - RugCheck API integration for token safety analysis
 * - Caching of validation results
 * - Configurable trading requirements
 * - Risk scoring and recommendations
 */
export class TokenValidationService extends Service {
  public static readonly serviceType = "TokenValidationService";
  public readonly capabilityDescription = "Validates token safety using RugCheck before trading";

  private readonly RUGCHECK_API = "https://api.rugcheck.xyz/v1/tokens";
  private readonly BIRDEYE_API = "https://public-api.birdeye.so/defi";
  private cache = new Map<string, RugCheckReport>();
  private activityCache = new Map<string, { data: TradingActivity; expiry: number }>();
  private requirements: TradingRequirements;
  private enabled: boolean;
  private birdeyeApiKey: string | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.requirements = DEFAULT_REQUIREMENTS;
    this.enabled = true;
  }

  public static async start(runtime: IAgentRuntime): Promise<TokenValidationService> {
    logger.info(`[${TokenValidationService.serviceType}] Starting...`);
    const instance = new TokenValidationService(runtime);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    const enabledSetting = this.runtime.getSetting("RUGCHECK_ENABLED");
    this.enabled = enabledSetting !== "false";

    const birdeyeKeySetting = this.runtime.getSetting("BIRDEYE_API_KEY");
    this.birdeyeApiKey = typeof birdeyeKeySetting === "string" ? birdeyeKeySetting : null;

    const minLiquidity = this.runtime.getSetting("MIN_LIQUIDITY_USD");
    if (minLiquidity) {
      this.requirements.minLiquidityUsd = Number(minLiquidity);
    }

    const minVolume = this.runtime.getSetting("MIN_VOLUME_24H_USD");
    if (minVolume) {
      this.requirements.minVolume24hUsd = Number(minVolume);
    }

    const minSells = this.runtime.getSetting("MIN_SELL_COUNT_24H");
    if (minSells) {
      this.requirements.minSellCount24h = Number(minSells);
    }

    const maxBuySellRatio = this.runtime.getSetting("MAX_BUY_SELL_RATIO");
    if (maxBuySellRatio) {
      this.requirements.maxBuySellRatio = Number(maxBuySellRatio);
    }

    logger.info(
      `[${TokenValidationService.serviceType}] Initialized: enabled=${this.enabled} hasBirdeyeKey=${!!this.birdeyeApiKey}`,
    );
  }

  public async stop(): Promise<void> {
    this.cache.clear();
    logger.info(`[${TokenValidationService.serviceType}] Stopped`);
  }

  /**
   * Set custom trading requirements
   */
  public setRequirements(requirements: Partial<TradingRequirements>): void {
    this.requirements = { ...this.requirements, ...requirements };
    logger.info(
      `[${TokenValidationService.serviceType}] Requirements updated: minLiquidity=$${this.requirements.minLiquidityUsd}`,
    );
  }

  /**
   * Get RugCheck report for a token (with caching)
   */
  public async getRugCheckReport(tokenAddress: string): Promise<RugCheckReport | null> {
    // Check cache first
    const cached = this.cache.get(tokenAddress);
    if (cached && cached.cacheExpiry > Date.now()) {
      logger.debug(
        `[${TokenValidationService.serviceType}] Using cached report for ${tokenAddress}`,
      );
      return cached;
    }

    const report = await this.fetchRugCheckReport(tokenAddress);
    if (report) {
      this.cache.set(tokenAddress, report);
    }

    return report;
  }

  /**
   * Fetch fresh report from RugCheck API
   */
  private async fetchRugCheckReport(tokenAddress: string): Promise<RugCheckReport | null> {
    logger.info(
      `[${TokenValidationService.serviceType}] Fetching RugCheck report for ${tokenAddress}`,
    );

    const response = await fetch(`${this.RUGCHECK_API}/${tokenAddress}/report`);

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(
          `[${TokenValidationService.serviceType}] Token not found in RugCheck: ${tokenAddress}`,
        );
        return this.createUnknownReport(tokenAddress);
      }
      logger.error(
        `[${TokenValidationService.serviceType}] RugCheck API error: status=${response.status} token=${tokenAddress}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      mint: string;
      risks: Array<{
        name: string;
        description: string;
        level: string;
        score: number;
      }>;
      score: number;
      tokenMeta: {
        name: string;
        symbol: string;
        decimals: number;
        supply: string;
        mintAuthority: string | null;
        freezeAuthority: string | null;
      };
      topHolders: Array<{ address: string; pct: number; insider: boolean }>;
      totalHolders: number;
      markets: Array<{
        marketType: string;
        lp: { lpLocked: boolean; lpLockedPct: number };
        liquidityA: string;
        liquidityB: string;
      }>;
    };

    const topHoldersPercent = data.topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);

    const totalLiquidityUsd = data.markets.reduce((sum, m) => {
      const liqA = Number.parseFloat(m.liquidityA || "0");
      const liqB = Number.parseFloat(m.liquidityB || "0");
      return sum + liqA + liqB;
    }, 0);

    const report: RugCheckReport = {
      tokenAddress,
      riskLevel: this.scoreToRiskLevel(data.score),
      score: data.score,
      risks: data.risks.map((r) => ({
        name: r.name,
        description: r.description,
        level: r.level as RiskLevel,
        score: r.score,
      })),
      tokenInfo: {
        name: data.tokenMeta.name,
        symbol: data.tokenMeta.symbol,
        decimals: data.tokenMeta.decimals,
        supply: data.tokenMeta.supply,
        mintAuthority: data.tokenMeta.mintAuthority,
        freezeAuthority: data.tokenMeta.freezeAuthority,
      },
      holders: {
        totalHolders: data.totalHolders,
        topHoldersPercent,
        top10Holders: data.topHolders.slice(0, 10).map((h) => ({
          address: h.address,
          percent: h.pct,
          isInsider: h.insider,
        })),
      },
      liquidity: {
        totalLiquidityUsd,
        pools: data.markets.map((m) => ({
          dex: m.marketType,
          liquidityUsd:
            Number.parseFloat(m.liquidityA || "0") + Number.parseFloat(m.liquidityB || "0"),
          lpLocked: m.lp.lpLocked,
          lpLockPercent: m.lp.lpLockedPct,
        })),
      },
      validatedAt: Date.now(),
      cacheExpiry: Date.now() + CACHE_DURATION_MS,
    };

    logger.info(
      `[${TokenValidationService.serviceType}] RugCheck report: ${report.tokenInfo.symbol} risk=${report.riskLevel} score=${report.score} liquidity=$${report.liquidity.totalLiquidityUsd.toFixed(0)}`,
    );

    return report;
  }

  /**
   * Create a report for unknown tokens
   */
  private createUnknownReport(tokenAddress: string): RugCheckReport {
    return {
      tokenAddress,
      riskLevel: "unknown",
      score: 100,
      risks: [
        {
          name: "Unknown Token",
          description: "Token not found in RugCheck database",
          level: "warning",
          score: 50,
        },
      ],
      tokenInfo: {
        name: "Unknown",
        symbol: "UNKNOWN",
        decimals: 9,
        supply: "0",
        mintAuthority: null,
        freezeAuthority: null,
      },
      holders: {
        totalHolders: 0,
        topHoldersPercent: 100,
        top10Holders: [],
      },
      liquidity: {
        totalLiquidityUsd: 0,
        pools: [],
      },
      validatedAt: Date.now(),
      cacheExpiry: Date.now() + CACHE_DURATION_MS / 6, // Shorter cache for unknown tokens
    };
  }

  /**
   * Convert score to risk level
   */
  private scoreToRiskLevel(score: number): RiskLevel {
    if (score <= 20) return "safe";
    if (score <= 50) return "warning";
    return "danger";
  }

  /**
   * Fetch trading activity from Birdeye for honeypot detection
   */
  public async getTradingActivity(tokenAddress: string): Promise<TradingActivity | null> {
    // Check cache first
    const cached = this.activityCache.get(tokenAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    if (!this.birdeyeApiKey) {
      logger.warn(
        `[${TokenValidationService.serviceType}] No Birdeye API key - skipping activity check`,
      );
      return null;
    }

    // Fetch token overview for volume and creation time
    const overviewResp = await fetch(`${this.BIRDEYE_API}/token_overview?address=${tokenAddress}`, {
      headers: { "X-API-KEY": this.birdeyeApiKey, "x-chain": "solana" },
    });

    if (!overviewResp.ok) {
      logger.warn(
        `[${TokenValidationService.serviceType}] Failed to fetch token overview: ${overviewResp.status}`,
      );
      return null;
    }

    const overviewData = (await overviewResp.json()) as {
      success: boolean;
      data: {
        v24hUSD: number;
        v24hChangePercent: number;
        trade24h: number;
        trade24hChangePercent: number;
        buy24h: number;
        sell24h: number;
        buyVolume24h: number;
        sellVolume24h: number;
        uniqueWallet24h: number;
        createdAt?: number;
        lastTradeUnixTime?: number;
      };
    };

    if (!overviewData.success || !overviewData.data) {
      logger.warn(
        `[${TokenValidationService.serviceType}] Invalid Birdeye response for ${tokenAddress}`,
      );
      return null;
    }

    const d = overviewData.data;
    const activity: TradingActivity = {
      volume24h: d.v24hUSD || 0,
      buyCount24h: d.buy24h || 0,
      sellCount24h: d.sell24h || 0,
      buyVolume24h: d.buyVolume24h || 0,
      sellVolume24h: d.sellVolume24h || 0,
      uniqueTraders24h: d.uniqueWallet24h || 0,
      createdAt: d.createdAt ? d.createdAt * 1000 : null,
      lastTradeAt: d.lastTradeUnixTime ? d.lastTradeUnixTime * 1000 : null,
    };

    // Cache for 5 minutes
    this.activityCache.set(tokenAddress, {
      data: activity,
      expiry: Date.now() + 5 * 60 * 1000,
    });

    logger.info(
      `[${TokenValidationService.serviceType}] Trading activity for ${tokenAddress}: vol=$${activity.volume24h.toFixed(0)} buys=${activity.buyCount24h} sells=${activity.sellCount24h} traders=${activity.uniqueTraders24h}`,
    );

    return activity;
  }

  /**
   * Check for honeypot indicators
   */
  private async checkHoneypotIndicators(
    tokenAddress: string,
    requirements: TradingRequirements,
  ): Promise<{ isHoneypot: boolean; reasons: string[]; warnings: string[] }> {
    const reasons: string[] = [];
    const warnings: string[] = [];

    const activity = await this.getTradingActivity(tokenAddress);
    if (!activity) {
      warnings.push("Could not fetch trading activity - honeypot check skipped");
      return { isHoneypot: false, reasons, warnings };
    }

    // Check for no sells (major honeypot signal)
    if (activity.sellCount24h === 0) {
      reasons.push("🚨 HONEYPOT: No sells in 24h - token may be unsellable");
    } else if (activity.sellCount24h < requirements.minSellCount24h) {
      reasons.push(
        `Very few sells in 24h: ${activity.sellCount24h} (min: ${requirements.minSellCount24h})`,
      );
    }

    // Check buy/sell ratio
    if (activity.sellCount24h > 0) {
      const buySellRatio = activity.buyCount24h / activity.sellCount24h;
      if (buySellRatio > requirements.maxBuySellRatio) {
        reasons.push(
          `🚨 Suspicious buy/sell ratio: ${buySellRatio.toFixed(1)}x more buys than sells (max: ${requirements.maxBuySellRatio}x)`,
        );
      } else if (buySellRatio > requirements.maxBuySellRatio * 0.7) {
        warnings.push(`High buy/sell ratio: ${buySellRatio.toFixed(1)}x`);
      }
    }

    // Check volume
    if (activity.volume24h < requirements.minVolume24hUsd) {
      reasons.push(
        `Insufficient volume: $${activity.volume24h.toLocaleString()} (min: $${requirements.minVolume24hUsd.toLocaleString()})`,
      );
    }

    // Check sell volume vs buy volume (honeypots often have 0 sell volume)
    if (activity.buyVolume24h > 0 && activity.sellVolume24h === 0) {
      reasons.push("🚨 HONEYPOT: Zero sell volume despite buy volume");
    } else if (activity.buyVolume24h > 0) {
      const volumeRatio = activity.buyVolume24h / (activity.sellVolume24h || 1);
      if (volumeRatio > 10) {
        warnings.push(`Buy volume 10x+ higher than sell volume: ${volumeRatio.toFixed(1)}x`);
      }
    }

    // Check unique traders
    if (activity.uniqueTraders24h < requirements.minUniqueTraders24h) {
      reasons.push(
        `Too few unique traders: ${activity.uniqueTraders24h} (min: ${requirements.minUniqueTraders24h})`,
      );
    }

    // Check token age
    if (activity.createdAt) {
      const ageSeconds = (Date.now() - activity.createdAt) / 1000;
      if (ageSeconds < requirements.minTokenAgeSeconds) {
        const ageHours = ageSeconds / 3600;
        const minHours = requirements.minTokenAgeSeconds / 3600;
        reasons.push(`Token too new: ${ageHours.toFixed(1)}h old (min: ${minHours}h)`);
      }
    }

    // Check for recent trading activity
    if (activity.lastTradeAt) {
      const timeSinceLastTrade = Date.now() - activity.lastTradeAt;
      if (timeSinceLastTrade > 30 * 60 * 1000) {
        // 30 minutes
        warnings.push(`No trades in ${(timeSinceLastTrade / 60000).toFixed(0)} minutes`);
      }
    }

    return { isHoneypot: reasons.length > 0, reasons, warnings };
  }

  /**
   * Validate a token against trading requirements
   */
  public async validateToken(
    tokenAddress: string,
    customRequirements?: Partial<TradingRequirements>,
  ): Promise<ValidationResult> {
    const requirements = { ...this.requirements, ...customRequirements };

    if (!this.enabled) {
      return {
        isValid: true,
        report: null,
        rejectionReasons: [],
        warnings: ["Token validation is disabled"],
      };
    }

    const report = await this.getRugCheckReport(tokenAddress);

    if (!report) {
      return {
        isValid: false,
        report: null,
        rejectionReasons: ["Failed to fetch token validation report"],
        warnings: [],
      };
    }

    const rejectionReasons: string[] = [];
    const warnings: string[] = [];

    // === HONEYPOT DETECTION (CRITICAL) ===
    const honeypotCheck = await this.checkHoneypotIndicators(tokenAddress, requirements);
    if (honeypotCheck.isHoneypot) {
      rejectionReasons.push(...honeypotCheck.reasons);
    }
    warnings.push(...honeypotCheck.warnings);

    // === RUG CHECK VALIDATION ===
    // Check risk level
    if (report.riskLevel === "danger") {
      rejectionReasons.push(`Token flagged as dangerous (risk score: ${report.score})`);
    }

    // Check rug pull score
    if (report.score > requirements.maxRugPullScore) {
      rejectionReasons.push(
        `Rug pull risk too high: ${report.score}% (max: ${requirements.maxRugPullScore}%)`,
      );
    }

    // Check liquidity
    if (report.liquidity.totalLiquidityUsd < requirements.minLiquidityUsd) {
      rejectionReasons.push(
        `Insufficient liquidity: $${report.liquidity.totalLiquidityUsd.toLocaleString()} ` +
          `(min: $${requirements.minLiquidityUsd.toLocaleString()})`,
      );
    }

    // Check holder concentration
    if (report.holders.topHoldersPercent > requirements.maxTopHoldersPercent) {
      rejectionReasons.push(
        `Top holders concentration too high: ${report.holders.topHoldersPercent.toFixed(1)}% ` +
          `(max: ${requirements.maxTopHoldersPercent}%)`,
      );
    }

    // Check LP lock if required
    if (requirements.requireLpLock) {
      const hasLockedLp = report.liquidity.pools.some((p) => p.lpLocked);
      if (!hasLockedLp) {
        rejectionReasons.push("No locked liquidity pool found");
      }
    }

    // === ADDITIONAL RISK FACTORS ===
    // Check for specific risk factors (warnings)
    for (const risk of report.risks) {
      if (risk.level === "warning") {
        warnings.push(`${risk.name}: ${risk.description}`);
      } else if (risk.level === "danger" && !rejectionReasons.includes(`RugCheck: ${risk.name}`)) {
        rejectionReasons.push(`RugCheck: ${risk.name} - ${risk.description}`);
      }
    }

    // Check mint authority
    if (report.tokenInfo.mintAuthority) {
      warnings.push("Mint authority is not renounced - token supply can be increased");
    }

    // Check freeze authority
    if (report.tokenInfo.freezeAuthority) {
      warnings.push("Freeze authority is not renounced - accounts can be frozen");
    }

    const isValid = rejectionReasons.length === 0;

    logger.info(
      `[${TokenValidationService.serviceType}] Validation result for ${tokenAddress}: valid=${isValid} rejections=${rejectionReasons.length} warnings=${warnings.length}`,
    );

    return {
      isValid,
      report,
      rejectionReasons,
      warnings,
    };
  }

  /**
   * Quick check if a token is safe to trade
   */
  public async isSafeToTrade(tokenAddress: string): Promise<boolean> {
    const result = await this.validateToken(tokenAddress);
    return result.isValid;
  }

  /**
   * Clear the validation cache
   */
  public clearCache(): void {
    this.cache.clear();
    logger.info(`[${TokenValidationService.serviceType}] Cache cleared`);
  }

  /**
   * Mark a token as flagged (e.g., after a rug pull)
   */
  public flagToken(tokenAddress: string, reason: string): void {
    const report = this.cache.get(tokenAddress);
    if (report) {
      report.riskLevel = "danger";
      report.score = 100;
      report.risks.push({
        name: "Manually Flagged",
        description: reason,
        level: "danger",
        score: 100,
      });
      report.cacheExpiry = Date.now() + CACHE_DURATION_MS * 4; // Extend cache for flagged tokens
    }
    logger.warn(
      `[${TokenValidationService.serviceType}] Token flagged: ${tokenAddress} reason=${reason}`,
    );
  }
}
