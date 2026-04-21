#!/usr/bin/env bun
/**
 * LP Manager Agent - Autonomous liquidity position management for DeFi
 */

import { AgentRuntime, logger, type Plugin } from "@elizaos/core";
import { character } from "./character";
import { LpMonitoringService } from "./services/LpMonitoringService";
import type {
  AgentStatus,
  LpAgentConfig,
  OpportunitySummary,
  PositionSummary,
} from "./types";

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const SOLANA_DEXES = new Set(["raydium", "orca", "meteora"]);

class LpManagerAgent {
  private runtime: AgentRuntime | null = null;
  private monitoring: LpMonitoringService | null = null;
  private isRunning = false;

  constructor(private config: LpAgentConfig) {}

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info(`[Agent] Starting for user: ${this.config.userId}`);

    this.runtime = new AgentRuntime({
      character: {
        ...character,
        settings: { ...character.settings, ...this.buildSettings() },
      },
      plugins: await this.loadPlugins(),
    });
    await this.runtime.initialize();

    await this.waitForServices();
    this.monitoring = await LpMonitoringService.start(this.runtime);
    await this.ensureProfile();
    await this.monitoring.startMonitoring(this.config.userId);

    this.isRunning = true;
    logger.info(
      `[Agent] Running, interval: ${this.config.checkIntervalMs ?? 300000}ms`,
    );
    this.logStatus();
  }

  private buildSettings(): Record<string, string> {
    const s: Record<string, string> = {};
    const { config: c } = this;

    // Credentials
    if (c.solanaPrivateKey) s.SOLANA_PRIVATE_KEY = c.solanaPrivateKey;
    if (c.solanaRpcUrl) s.SOLANA_RPC_URL = c.solanaRpcUrl;
    if (c.evmPrivateKey) s.EVM_PRIVATE_KEY = c.evmPrivateKey;

    // EVM RPCs
    const rpcs = c.evmRpcUrls ?? {};
    if (rpcs.ethereum) s.ETHEREUM_RPC_URL = rpcs.ethereum;
    if (rpcs.base) s.BASE_RPC_URL = rpcs.base;
    if (rpcs.arbitrum) s.ARBITRUM_RPC_URL = rpcs.arbitrum;
    if (rpcs.bsc) s.BSC_RPC_URL = rpcs.bsc;
    if (rpcs.polygon) s.POLYGON_RPC_URL = rpcs.polygon;
    if (rpcs.optimism) s.OPTIMISM_RPC_URL = rpcs.optimism;

    // Config values
    const configMap: [keyof LpAgentConfig, string][] = [
      ["checkIntervalMs", "LP_CHECK_INTERVAL_MS"],
      ["minGainThresholdPercent", "LP_MIN_GAIN_THRESHOLD_PERCENT"],
      ["maxSlippageBps", "LP_MAX_SLIPPAGE_BPS"],
      ["autoRebalanceEnabled", "LP_AUTO_REBALANCE_ENABLED"],
      [
        "concentratedRepositionThreshold",
        "LP_CONCENTRATED_REPOSITION_THRESHOLD",
      ],
      ["maxPositionSizeUsd", "LP_MAX_POSITION_SIZE_USD"],
      ["minPoolTvlUsd", "LP_MIN_POOL_TVL_USD"],
      ["maxIlRiskPercent", "LP_MAX_IL_RISK_PERCENT"],
    ];
    for (const [key, envKey] of configMap) {
      if (c[key] !== undefined) s[envKey] = String(c[key]);
    }

    // DEX preferences
    if (c.solanaDexes)
      s.LP_SOLANA_DEXES = Array.isArray(c.solanaDexes)
        ? c.solanaDexes.join(",")
        : c.solanaDexes;
    if (c.evmDexes)
      s.LP_EVM_DEXES = Array.isArray(c.evmDexes)
        ? c.evmDexes.join(",")
        : c.evmDexes;

    return s;
  }

  private async loadPlugins(): Promise<Plugin[]> {
    const sql = (await import("@elizaos/plugin-sql")).default;
    const lp = (
      (await import("@elizaos/plugin-lp-manager")) as { default: Plugin }
    ).default;
    return [sql, lp];
  }

  private async waitForServices(): Promise<void> {
    for (let i = 0; i < 15; i++) {
      if (
        this.runtime?.getService("dex-interaction") &&
        this.runtime?.getService("VaultService") &&
        this.runtime?.getService("UserLpProfileService")
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    logger.warn("[Agent] Services may not be ready");
  }

  private async ensureProfile(): Promise<void> {
    type ProfileSvc = {
      ensureProfile(
        u: string,
        pk: string,
        sk: string,
        cfg: Record<string, unknown>,
      ): Promise<unknown>;
    };
    type VaultSvc = {
      createVault(
        u: string,
      ): Promise<{ publicKey: string; secretKeyEncrypted: string }>;
    };

    const profile = this.runtime?.getService(
      "UserLpProfileService",
    ) as ProfileSvc | null;
    const vault = this.runtime?.getService("VaultService") as VaultSvc | null;
    if (!profile || !vault) {
      logger.warn(
        "[Agent] Profile/Vault services unavailable - user profile may not be initialized",
      );
      return;
    }

    const v = await vault.createVault(this.config.userId);
    await profile.ensureProfile(
      this.config.userId,
      v.publicKey,
      v.secretKeyEncrypted,
      {
        enabled: this.config.autoRebalanceEnabled ?? true,
        minGainThresholdPercent: this.config.minGainThresholdPercent ?? 1.0,
        maxSlippageBps: this.config.maxSlippageBps ?? 50,
      },
    );
    logger.info(`[Agent] Profile ready, vault: ${v.publicKey.slice(0, 8)}...`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info("[Agent] Stopping...");
    await this.monitoring?.stop();
    await this.runtime?.stop();
    this.isRunning = false;
  }

  getStatus(): AgentStatus {
    const status = this.monitoring?.getStatus();
    const positions = this.monitoring?.getPositions() ?? [];
    const opportunities = this.monitoring?.getOpportunities() ?? [];

    const posSummaries: PositionSummary[] = positions.map((p) => ({
      poolId: p.position.poolId,
      dex: p.position.dex,
      chain: SOLANA_DEXES.has(p.position.dex.toLowerCase()) ? "solana" : "evm",
      tokenA: p.position.underlyingTokens[0]?.symbol ?? "?",
      tokenB: p.position.underlyingTokens[1]?.symbol ?? "?",
      valueUsd: p.position.valueUsd ?? 0,
      currentApr: p.currentApr,
      isConcentrated: p.isConcentrated,
      inRange: (p.priceDistanceFromRange ?? 0) <= 0,
      priceDistancePercent: p.priceDistanceFromRange,
      warnings: p.warnings,
      rebalancable: p.rebalancable,
      rebalanceBlockedReason: p.rebalanceBlockedReason,
      volume24h: p.volume24h,
    }));

    const oppSummaries: OpportunitySummary[] = opportunities.map((o, i) => ({
      index: i,
      fromPool: o.opportunity.sourcePosition?.poolId ?? null,
      fromDex: o.opportunity.sourcePosition?.dex ?? null,
      toPool: o.opportunity.targetPool.id,
      toDex: o.opportunity.targetPool.dex,
      currentApr: o.opportunity.currentYield ?? 0,
      newApr: o.opportunity.estimatedNewYield ?? 0,
      netGainPercent: o.estimatedNetGain,
      estimatedCostUsd: o.opportunity.estimatedCostToMoveUsd ?? 0,
      shouldExecute: o.shouldExecute,
      reason: o.reason,
      riskScore: o.riskScore,
      opportunityScore: o.opportunityScore,
      isHighAprOpportunity: o.isHighAprOpportunity,
      aprQuality: o.aprQuality,
    }));

    const totalApr = posSummaries.reduce((s, p) => s + p.currentApr, 0);

    return {
      isRunning: this.isRunning,
      isMonitoring: status?.isMonitoring ?? false,
      userId: this.config.userId,
      lastCheckAt: status?.lastCheckAt ? new Date(status.lastCheckAt) : null,
      nextCheckAt: status?.nextCheckAt ? new Date(status.nextCheckAt) : null,
      positions: posSummaries,
      opportunities: oppSummaries,
      recentRebalances: (status?.recentRebalances ?? []).map((r) => ({
        timestamp: new Date(r.executedAt),
        success: r.success,
        fromPool: r.fromPool,
        toPool: r.toPool,
        previousApr: r.previousApr,
        newApr: r.newApr,
        error: r.error,
      })),
      totalValueUsd: status?.totalValueUsd ?? 0,
      averageApr: posSummaries.length ? totalApr / posSummaries.length : 0,
    };
  }

  logStatus(): void {
    const s = this.getStatus();
    const line = "─".repeat(60);

    logger.info(`\n${line}\n LP MANAGER STATUS\n${line}`);
    logger.info(`Running: ${s.isRunning} | Monitoring: ${s.isMonitoring}`);
    logger.info(
      `Last: ${s.lastCheckAt?.toISOString() ?? "-"} | Next: ${s.nextCheckAt?.toISOString() ?? "-"}\n`,
    );

    if (s.positions.length) {
      logger.info("POSITIONS:");
      for (const p of s.positions) {
        const range = p.isConcentrated
          ? p.inRange
            ? "✓"
            : `⚠ ${p.priceDistancePercent?.toFixed(1)}%`
          : "";
        const lock = p.rebalancable ? "" : "🔒";
        const poolIdShort =
          p.poolId.length > 8 ? p.poolId.slice(0, 8) : p.poolId;
        logger.info(
          `  ${lock}${p.dex}:${poolIdShort} ${p.tokenA}/${p.tokenB} $${p.valueUsd.toFixed(0)} @${(p.currentApr * 100).toFixed(1)}% ${range}`,
        );
        for (const w of p.warnings) {
          logger.warn(`    ⚠ ${w}`);
        }
      }
    } else {
      logger.info("POSITIONS: none");
    }

    if (s.opportunities.length) {
      logger.info("\nOPPORTUNITIES:");
      for (const o of s.opportunities) {
        const icon = o.shouldExecute ? "✓" : "✗";
        const star = o.isHighAprOpportunity ? "⭐" : "";
        const qual =
          o.aprQuality === "sustainable"
            ? "🟢"
            : o.aprQuality === "unsustainable"
              ? "🔴"
              : "";
        logger.info(
          `  ${icon} ${o.fromDex ?? "idle"}→${o.toDex} +${o.netGainPercent.toFixed(2)}% ${star}${qual}`,
        );
        logger.info(
          `    Score:${o.opportunityScore} Risk:${o.riskScore} - ${o.reason}`,
        );
      }
    }

    const rebal = s.positions.filter((p) => p.rebalancable).length;
    const highApr = s.opportunities.filter(
      (o) => o.isHighAprOpportunity,
    ).length;
    logger.info(
      `\nSUMMARY: $${s.totalValueUsd.toFixed(0)} | APR: ${(s.averageApr * 100).toFixed(1)}% | Pos: ${s.positions.length} (${rebal} rebal) | Opp: ${s.opportunities.length} (${highApr} high-APR)`,
    );
    logger.info(line);
  }

  async triggerCheck(): Promise<void> {
    await this.monitoring?.triggerCheck(this.config.userId);
    this.logStatus();
  }

  async triggerRebalance(index: number): Promise<void> {
    const result = await this.monitoring?.triggerRebalance(
      this.config.userId,
      index,
    );
    if (result)
      logger.info(
        `[Agent] Rebalance ${result.success ? "✓" : "✗"}: ${result.error ?? ""}`,
      );
    this.logStatus();
  }
}

function loadConfigFromEnv(): LpAgentConfig {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    if (!v) return d;
    const n = Number(v);
    return Number.isNaN(n) ? d : n;
  };
  return {
    userId: process.env.LP_USER_ID ?? `lp-${Date.now()}`,
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,
    solanaRpcUrl:
      process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    evmPrivateKey: process.env.EVM_PRIVATE_KEY,
    evmRpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL,
      base: process.env.BASE_RPC_URL,
      arbitrum: process.env.ARBITRUM_RPC_URL,
      bsc: process.env.BSC_RPC_URL,
      polygon: process.env.POLYGON_RPC_URL,
      optimism: process.env.OPTIMISM_RPC_URL,
    },
    checkIntervalMs: num("LP_CHECK_INTERVAL_MS", 300000),
    minGainThresholdPercent: num("LP_MIN_GAIN_THRESHOLD_PERCENT", 1.0),
    maxSlippageBps: num("LP_MAX_SLIPPAGE_BPS", 50),
    autoRebalanceEnabled: !["false", "0", "no", "off", "disabled"].includes(
      (process.env.LP_AUTO_REBALANCE_ENABLED ?? "").toLowerCase(),
    ),
    concentratedRepositionThreshold: num(
      "LP_CONCENTRATED_REPOSITION_THRESHOLD",
      0.1,
    ),
    maxPositionSizeUsd: num("LP_MAX_POSITION_SIZE_USD", 10000),
    minPoolTvlUsd: num("LP_MIN_POOL_TVL_USD", 100000),
    maxIlRiskPercent: num("LP_MAX_IL_RISK_PERCENT", 10),
    solanaDexes: process.env.LP_SOLANA_DEXES,
    evmDexes: process.env.LP_EVM_DEXES,
  };
}

async function main(): Promise<void> {
  logger.info("\n╔══════════════════════════════════════════════╗");
  logger.info("║          LP MANAGER AGENT                    ║");
  logger.info("╚══════════════════════════════════════════════╝\n");

  const config = loadConfigFromEnv();

  if (!config.solanaPrivateKey && !config.evmPrivateKey) {
    logger.warn("⚠ No wallet keys configured - observation mode only\n");
  }

  const agent = new LpManagerAgent(config);

  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.start();

  let cycle = 0;
  setInterval(() => {
    if (++cycle % 10 === 0) agent.logStatus();
  }, config.checkIntervalMs ?? 300000);

  logger.info("Press Ctrl+C to stop\n");

  if (process.stdin.isTTY) {
    const rl = (await import("node:readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on("line", async (cmd: string) => {
      const c = cmd.trim().toLowerCase();
      if (c === "s" || c === "status") agent.logStatus();
      else if (c === "c" || c === "check") await agent.triggerCheck();
      else if (c === "h" || c === "help")
        logger.info("Commands: status(s), check(c), help(h), quit(q)");
      else if (c === "q" || c === "quit") await shutdown();
      else if (c) logger.info(`Unknown: ${c}. Type 'help'`);
    });
  }
}

if (import.meta.main) {
  main().catch((e) => {
    logger.error(`Fatal: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}

export { LpManagerAgent, loadConfigFromEnv };
export type { LpAgentConfig };
