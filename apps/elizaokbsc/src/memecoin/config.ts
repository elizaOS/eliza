import {
  DEFAULT_DASHBOARD_ENABLED,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DISCOVERY_INTERVAL_MS,
  DEFAULT_DISTRIBUTION_ENABLED,
  DEFAULT_DISTRIBUTION_EXECUTION_DRY_RUN,
  DEFAULT_DISTRIBUTION_EXECUTION_ENABLED,
  DEFAULT_DISTRIBUTION_EXECUTION_AUTO_SELECT_ASSET,
  DEFAULT_DISTRIBUTION_EXECUTION_LIVE_CONFIRM,
  DEFAULT_DISTRIBUTION_EXECUTION_MAX_RECIPIENTS_PER_RUN,
  DEFAULT_DISTRIBUTION_MAX_RECIPIENTS,
  DEFAULT_DISTRIBUTION_MIN_ELIGIBLE_BALANCE,
  DEFAULT_DISTRIBUTION_MIN_PORTFOLIO_SHARE_PCT,
  DEFAULT_DISTRIBUTION_MIN_WALLET_QUOTE_USD,
  DEFAULT_DISTRIBUTION_POOL_PCT,
  DEFAULT_DISTRIBUTION_REQUIRE_POSITIVE_PNL,
  DEFAULT_DISTRIBUTION_REQUIRE_TAKE_PROFIT_HIT,
  DEFAULT_DISTRIBUTION_REQUIRE_VERIFIED_WALLET,
  DEFAULT_DISTRIBUTION_START_BLOCK,
  DEFAULT_DISTRIBUTION_SNAPSHOT_PATH,
  DEFAULT_GOO_LOOKBACK_BLOCKS,
  DEFAULT_GOO_MAX_AGENTS,
  DEFAULT_GOO_MEMO_TOP_COUNT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MEMO_TOP_COUNT,
  DEFAULT_NEW_POOLS_LIMIT,
  DEFAULT_EXECUTION_ALLOWED_QUOTE_ONLY,
  DEFAULT_EXECUTION_DRY_RUN,
  DEFAULT_EXECUTION_DRY_RUN_COOLDOWN_MS,
  DEFAULT_EXECUTION_ENABLED,
  DEFAULT_EXECUTION_KOL_ENABLED,
  DEFAULT_EXECUTION_KOL_MIN_HOLDER_COUNT,
  DEFAULT_EXECUTION_KOL_PUBLIC_CACHE_PATH,
  DEFAULT_EXECUTION_KOL_PUBLIC_LOOKBACK_BLOCKS,
  DEFAULT_EXECUTION_KOL_PUBLIC_MIN_TOKEN_HITS,
  DEFAULT_EXECUTION_KOL_PUBLIC_SOURCE_ENABLED,
  DEFAULT_EXECUTION_KOL_PUBLIC_TOKEN_LIMIT,
  DEFAULT_EXECUTION_KOL_PUBLIC_WALLET_LIMIT,
  DEFAULT_EXECUTION_LIVE_CONFIRM_PHRASE,
  DEFAULT_EXECUTION_MAX_ACTIVE_POSITIONS,
  DEFAULT_EXECUTION_MAX_ENTRY_MCAP_USD,
  DEFAULT_EXECUTION_MAX_BUY_BNB,
  DEFAULT_EXECUTION_MAX_BUYS_PER_CYCLE,
  DEFAULT_EXECUTION_MAX_DAILY_DEPLOY_BNB,
  DEFAULT_EXECUTION_MAX_POOL_AGE_MINUTES,
  DEFAULT_EXECUTION_MAX_PRICE_CHANGE_H1_PCT,
  DEFAULT_EXECUTION_MAX_SLIPPAGE_BPS,
  DEFAULT_EXECUTION_MIN_BUYERS_M5,
  DEFAULT_EXECUTION_MIN_ENTRY_MCAP_USD,
  DEFAULT_EXECUTION_MIN_LIQUIDITY_USD,
  DEFAULT_EXECUTION_MIN_NET_BUYS_M5,
  DEFAULT_EXECUTION_MIN_POOL_AGE_MINUTES,
  DEFAULT_EXECUTION_MIN_VOLUME_M5_USD,
  DEFAULT_EXECUTION_MIN_VOLUME_H1_USD,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_EXECUTION_ROUTER,
  DEFAULT_REPORTS_DIR,
  DEFAULT_RUN_ON_STARTUP,
  DEFAULT_TREASURY_MAX_ACTIVE_POSITIONS,
  DEFAULT_TREASURY_PAPER_CAPITAL_USD,
  DEFAULT_TREASURY_RESERVE_PCT,
  DEFAULT_TREASURY_TAKE_PROFIT_RULES,
  DEFAULT_TREASURY_STOP_LOSS_PCT,
  DEFAULT_TREASURY_EXIT_SCORE_THRESHOLD,
  DEFAULT_TRENDING_POOLS_LIMIT,
} from "./constants";
import type { DiscoveryConfig } from "./types";

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envInt(name: string, defaultValue: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) {
    return defaultValue;
  }

  return parsed;
}

function envFloat(name: string, defaultValue: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < min) {
    return defaultValue;
  }

  return parsed;
}

function envString(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

function envExecutionMode() {
  const raw = process.env.ELIZAOK_EXECUTION_MODE?.trim().toLowerCase();
  if (raw === "live_buy_only" || raw === "live_full" || raw === "paper") return raw;
  return DEFAULT_EXECUTION_MODE as "paper";
}

function envExecutionRouter() {
  const raw = process.env.ELIZAOK_EXECUTION_ROUTER?.trim().toLowerCase();
  if (raw === "fourmeme" || raw === "pancakeswap") return raw;
  return DEFAULT_EXECUTION_ROUTER as "fourmeme";
}

function parseTakeProfitRules(raw: string) {
  return raw
    .split(",")
    .map((chunk, index) => {
      const [gainRaw, sellRaw] = chunk.split(":").map((part) => part?.trim());
      const gainPct = Number.parseInt(gainRaw || "", 10);
      const sellPct = Number.parseInt(sellRaw || "", 10);
      if (Number.isNaN(gainPct) || Number.isNaN(sellPct) || gainPct <= 0 || sellPct <= 0) {
        return null;
      }

      return {
        label: `TP${index + 1}`,
        gainPct,
        sellPct: Math.min(100, sellPct),
      };
    })
    .filter((rule): rule is NonNullable<typeof rule> => Boolean(rule))
    .sort((a, b) => a.gainPct - b.gainPct);
}

export function getDiscoveryConfig(): DiscoveryConfig {
  return {
    enabled: envBool("ELIZAOK_DISCOVERY_ENABLED", true),
    runOnStartup: envBool("ELIZAOK_DISCOVERY_RUN_ON_STARTUP", DEFAULT_RUN_ON_STARTUP),
    intervalMs: envInt("ELIZAOK_DISCOVERY_INTERVAL_MS", DEFAULT_DISCOVERY_INTERVAL_MS, 60_000),
    newPoolsLimit: envInt("ELIZAOK_DISCOVERY_NEW_POOLS_LIMIT", DEFAULT_NEW_POOLS_LIMIT, 1),
    trendingPoolsLimit: envInt(
      "ELIZAOK_DISCOVERY_TRENDING_POOLS_LIMIT",
      DEFAULT_TRENDING_POOLS_LIMIT,
      0
    ),
    maxCandidates: envInt("ELIZAOK_DISCOVERY_MAX_CANDIDATES", DEFAULT_MAX_CANDIDATES, 1),
    memoTopCount: envInt("ELIZAOK_MEMO_TOP_COUNT", DEFAULT_MEMO_TOP_COUNT, 1),
    reportsDir: process.env.ELIZAOK_REPORTS_DIR?.trim() || DEFAULT_REPORTS_DIR,
    historyLimit: envInt("ELIZAOK_HISTORY_LIMIT", DEFAULT_HISTORY_LIMIT, 1),
    dashboard: {
      enabled: envBool("ELIZAOK_DASHBOARD_ENABLED", DEFAULT_DASHBOARD_ENABLED),
      port: envInt("ELIZAOK_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT, 1_024),
    },
    treasury: {
      paperCapitalUsd: envInt(
        "ELIZAOK_TREASURY_PAPER_CAPITAL_USD",
        DEFAULT_TREASURY_PAPER_CAPITAL_USD,
        100
      ),
      maxActivePositions: envInt(
        "ELIZAOK_TREASURY_MAX_ACTIVE_POSITIONS",
        DEFAULT_TREASURY_MAX_ACTIVE_POSITIONS,
        1
      ),
      reservePct: envInt("ELIZAOK_TREASURY_RESERVE_PCT", DEFAULT_TREASURY_RESERVE_PCT, 0),
      takeProfitRules: parseTakeProfitRules(
        process.env.ELIZAOK_TREASURY_TAKE_PROFIT_RULES?.trim() ||
          DEFAULT_TREASURY_TAKE_PROFIT_RULES
      ),
      stopLossPct: Number.parseInt(
        process.env.ELIZAOK_TREASURY_STOP_LOSS_PCT?.trim() || "",
        10
      ) || DEFAULT_TREASURY_STOP_LOSS_PCT,
      exitScoreThreshold: envInt(
        "ELIZAOK_TREASURY_EXIT_SCORE_THRESHOLD",
        DEFAULT_TREASURY_EXIT_SCORE_THRESHOLD,
        1
      ),
    },
    execution: {
      enabled: envBool("ELIZAOK_EXECUTION_ENABLED", DEFAULT_EXECUTION_ENABLED),
      dryRun: envBool("ELIZAOK_EXECUTION_DRY_RUN", DEFAULT_EXECUTION_DRY_RUN),
      dryRunCooldownMs: envInt(
        "ELIZAOK_EXECUTION_DRY_RUN_COOLDOWN_MS",
        DEFAULT_EXECUTION_DRY_RUN_COOLDOWN_MS,
        0
      ),
      liveConfirmPhrase:
        process.env.ELIZAOK_EXECUTION_LIVE_CONFIRM_PHRASE?.trim() ||
        DEFAULT_EXECUTION_LIVE_CONFIRM_PHRASE,
      liveConfirmValue: envString("ELIZAOK_EXECUTION_LIVE_CONFIRM"),
      liveConfirmArmed:
        (process.env.ELIZAOK_EXECUTION_LIVE_CONFIRM?.trim() || "") ===
        (process.env.ELIZAOK_EXECUTION_LIVE_CONFIRM_PHRASE?.trim() ||
          DEFAULT_EXECUTION_LIVE_CONFIRM_PHRASE),
      mode: envExecutionMode(),
      router: envExecutionRouter(),
      rpcUrl: envString("ELIZAOK_BSC_RPC_URL"),
      walletAddress: envString("ELIZAOK_EXECUTION_WALLET_ADDRESS"),
      privateKey: envString("ELIZAOK_EXECUTION_PRIVATE_KEY"),
      privateKeyConfigured: Boolean(envString("ELIZAOK_EXECUTION_PRIVATE_KEY")),
      fourMemeCliCommand:
        process.env.ELIZAOK_FOURMEME_CLI_COMMAND?.trim() || "npx fourmeme",
      fourMemeBuyTemplate: envString("ELIZAOK_FOURMEME_BUY_TEMPLATE"),
      maxBuysPerCycle: envInt(
        "ELIZAOK_EXECUTION_MAX_BUYS_PER_CYCLE",
        DEFAULT_EXECUTION_MAX_BUYS_PER_CYCLE,
        1
      ),
      risk: {
        maxBuyBnb: envFloat("ELIZAOK_MAX_BUY_BNB", DEFAULT_EXECUTION_MAX_BUY_BNB, 0.00000001),
        maxDailyDeployBnb: envFloat(
          "ELIZAOK_MAX_DAILY_DEPLOY_BNB",
          DEFAULT_EXECUTION_MAX_DAILY_DEPLOY_BNB,
          0.00000001
        ),
        maxSlippageBps: envInt(
          "ELIZAOK_MAX_SLIPPAGE_BPS",
          DEFAULT_EXECUTION_MAX_SLIPPAGE_BPS,
          1
        ),
        maxActivePositions: envInt(
          "ELIZAOK_EXECUTION_MAX_ACTIVE_POSITIONS",
          DEFAULT_EXECUTION_MAX_ACTIVE_POSITIONS,
          1
        ),
        minEntryMcapUsd: envInt(
          "ELIZAOK_MIN_ENTRY_MCAP_USD",
          DEFAULT_EXECUTION_MIN_ENTRY_MCAP_USD,
          0
        ),
        maxEntryMcapUsd: envInt(
          "ELIZAOK_MAX_ENTRY_MCAP_USD",
          DEFAULT_EXECUTION_MAX_ENTRY_MCAP_USD,
          1
        ),
        minLiquidityUsd: envInt(
          "ELIZAOK_MIN_LIQUIDITY_USD",
          DEFAULT_EXECUTION_MIN_LIQUIDITY_USD,
          0
        ),
        minVolumeUsdM5: envInt(
          "ELIZAOK_MIN_VOLUME_M5_USD",
          DEFAULT_EXECUTION_MIN_VOLUME_M5_USD,
          0
        ),
        minVolumeUsdH1: envInt(
          "ELIZAOK_MIN_VOLUME_H1_USD",
          DEFAULT_EXECUTION_MIN_VOLUME_H1_USD,
          0
        ),
        minBuyersM5: envInt(
          "ELIZAOK_MIN_BUYERS_M5",
          DEFAULT_EXECUTION_MIN_BUYERS_M5,
          0
        ),
        minNetBuysM5: envInt(
          "ELIZAOK_MIN_NET_BUYS_M5",
          DEFAULT_EXECUTION_MIN_NET_BUYS_M5,
          -1000
        ),
        minPoolAgeMinutes: envInt(
          "ELIZAOK_MIN_POOL_AGE_MINUTES",
          DEFAULT_EXECUTION_MIN_POOL_AGE_MINUTES,
          0
        ),
        maxPoolAgeMinutes: envInt(
          "ELIZAOK_MAX_POOL_AGE_MINUTES",
          DEFAULT_EXECUTION_MAX_POOL_AGE_MINUTES,
          1
        ),
        maxPriceChangeH1Pct: envInt(
          "ELIZAOK_MAX_PRICE_CHANGE_H1_PCT",
          DEFAULT_EXECUTION_MAX_PRICE_CHANGE_H1_PCT,
          1
        ),
        allowedQuoteOnly: envBool(
          "ELIZAOK_EXECUTION_ALLOWED_QUOTE_ONLY",
          DEFAULT_EXECUTION_ALLOWED_QUOTE_ONLY
        ),
      },
      kol: {
        enabled: envBool("ELIZAOK_KOL_ENABLED", DEFAULT_EXECUTION_KOL_ENABLED),
        walletsPath: envString("ELIZAOK_KOL_WALLETS_PATH"),
        minHolderCount: envInt(
          "ELIZAOK_KOL_MIN_HOLDER_COUNT",
          DEFAULT_EXECUTION_KOL_MIN_HOLDER_COUNT,
          1
        ),
        publicSourceEnabled: envBool(
          "ELIZAOK_KOL_PUBLIC_SOURCE_ENABLED",
          DEFAULT_EXECUTION_KOL_PUBLIC_SOURCE_ENABLED
        ),
        publicSourceTokenLimit: envInt(
          "ELIZAOK_KOL_PUBLIC_TOKEN_LIMIT",
          DEFAULT_EXECUTION_KOL_PUBLIC_TOKEN_LIMIT,
          1
        ),
        publicSourceLookbackBlocks: envInt(
          "ELIZAOK_KOL_PUBLIC_LOOKBACK_BLOCKS",
          DEFAULT_EXECUTION_KOL_PUBLIC_LOOKBACK_BLOCKS,
          50
        ),
        publicSourceMinTokenHits: envInt(
          "ELIZAOK_KOL_PUBLIC_MIN_TOKEN_HITS",
          DEFAULT_EXECUTION_KOL_PUBLIC_MIN_TOKEN_HITS,
          1
        ),
        publicSourceWalletLimit: envInt(
          "ELIZAOK_KOL_PUBLIC_WALLET_LIMIT",
          DEFAULT_EXECUTION_KOL_PUBLIC_WALLET_LIMIT,
          1
        ),
        publicCachePath:
          envString("ELIZAOK_KOL_PUBLIC_CACHE_PATH") || DEFAULT_EXECUTION_KOL_PUBLIC_CACHE_PATH,
      },
    },
    distribution: {
      enabled: envBool("ELIZAOK_DISTRIBUTION_ENABLED", DEFAULT_DISTRIBUTION_ENABLED),
      snapshotPath:
        process.env.ELIZAOK_DISTRIBUTION_SNAPSHOT_PATH?.trim() ||
        DEFAULT_DISTRIBUTION_SNAPSHOT_PATH,
      holderTokenAddress: envString("ELIZAOK_DISTRIBUTION_TOKEN_ADDRESS"),
      minEligibleBalance: envInt(
        "ELIZAOK_DISTRIBUTION_MIN_ELIGIBLE_BALANCE",
        DEFAULT_DISTRIBUTION_MIN_ELIGIBLE_BALANCE,
        1
      ),
      maxRecipients: envInt(
        "ELIZAOK_DISTRIBUTION_MAX_RECIPIENTS",
        DEFAULT_DISTRIBUTION_MAX_RECIPIENTS,
        1
      ),
      poolPct: envInt("ELIZAOK_DISTRIBUTION_POOL_PCT", DEFAULT_DISTRIBUTION_POOL_PCT, 0),
      startBlock: process.env.ELIZAOK_DISTRIBUTION_START_BLOCK?.trim()
        ? envInt("ELIZAOK_DISTRIBUTION_START_BLOCK", DEFAULT_DISTRIBUTION_START_BLOCK, 0)
        : null,
      execution: {
        enabled: envBool(
          "ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED",
          DEFAULT_DISTRIBUTION_EXECUTION_ENABLED
        ),
        dryRun: envBool(
          "ELIZAOK_DISTRIBUTION_EXECUTION_DRY_RUN",
          DEFAULT_DISTRIBUTION_EXECUTION_DRY_RUN
        ),
        autoSelectAsset: envBool(
          "ELIZAOK_DISTRIBUTION_EXECUTION_AUTO_SELECT_ASSET",
          DEFAULT_DISTRIBUTION_EXECUTION_AUTO_SELECT_ASSET
        ),
        assetTokenAddress: envString("ELIZAOK_DISTRIBUTION_ASSET_TOKEN_ADDRESS"),
        assetTotalAmount: envString("ELIZAOK_DISTRIBUTION_ASSET_TOTAL_AMOUNT"),
        walletAddress: envString("ELIZAOK_DISTRIBUTION_WALLET_ADDRESS"),
        privateKey: envString("ELIZAOK_DISTRIBUTION_PRIVATE_KEY"),
        liveConfirmPhrase: DEFAULT_DISTRIBUTION_EXECUTION_LIVE_CONFIRM,
        liveConfirmArmed:
          (envString("ELIZAOK_DISTRIBUTION_LIVE_CONFIRM") || "") ===
          DEFAULT_DISTRIBUTION_EXECUTION_LIVE_CONFIRM,
        maxRecipientsPerRun: envInt(
          "ELIZAOK_DISTRIBUTION_EXECUTION_MAX_RECIPIENTS_PER_RUN",
          DEFAULT_DISTRIBUTION_EXECUTION_MAX_RECIPIENTS_PER_RUN,
          1
        ),
        requireVerifiedWallet: envBool(
          "ELIZAOK_DISTRIBUTION_REQUIRE_VERIFIED_WALLET",
          DEFAULT_DISTRIBUTION_REQUIRE_VERIFIED_WALLET
        ),
        requirePositivePnl: envBool(
          "ELIZAOK_DISTRIBUTION_REQUIRE_POSITIVE_PNL",
          DEFAULT_DISTRIBUTION_REQUIRE_POSITIVE_PNL
        ),
        requireTakeProfitHit: envBool(
          "ELIZAOK_DISTRIBUTION_REQUIRE_TAKE_PROFIT_HIT",
          DEFAULT_DISTRIBUTION_REQUIRE_TAKE_PROFIT_HIT
        ),
        minWalletQuoteUsd: envInt(
          "ELIZAOK_DISTRIBUTION_MIN_WALLET_QUOTE_USD",
          DEFAULT_DISTRIBUTION_MIN_WALLET_QUOTE_USD,
          0
        ),
        minPortfolioSharePct: envInt(
          "ELIZAOK_DISTRIBUTION_MIN_PORTFOLIO_SHARE_PCT",
          DEFAULT_DISTRIBUTION_MIN_PORTFOLIO_SHARE_PCT,
          0
        ),
      },
    },
    goo: {
      enabled: envBool("ELIZAOK_GOO_SCAN_ENABLED", false),
      rpcUrl: envString("ELIZAOK_GOO_RPC_URL"),
      registryAddress: envString("ELIZAOK_GOO_REGISTRY_ADDRESS"),
      lookbackBlocks: envInt(
        "ELIZAOK_GOO_LOOKBACK_BLOCKS",
        DEFAULT_GOO_LOOKBACK_BLOCKS,
        100
      ),
      maxAgents: envInt("ELIZAOK_GOO_MAX_AGENTS", DEFAULT_GOO_MAX_AGENTS, 1),
      memoTopCount: envInt("ELIZAOK_GOO_MEMO_TOP_COUNT", DEFAULT_GOO_MEMO_TOP_COUNT, 1),
    },
  };
}
