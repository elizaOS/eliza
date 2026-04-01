import {
  DEFAULT_DASHBOARD_ENABLED,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DISCOVERY_INTERVAL_MS,
  DEFAULT_GOO_LOOKBACK_BLOCKS,
  DEFAULT_GOO_MAX_AGENTS,
  DEFAULT_GOO_MEMO_TOP_COUNT,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MEMO_TOP_COUNT,
  DEFAULT_NEW_POOLS_LIMIT,
  DEFAULT_REPORTS_DIR,
  DEFAULT_RUN_ON_STARTUP,
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

function envString(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
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
    dashboard: {
      enabled: envBool("ELIZAOK_DASHBOARD_ENABLED", DEFAULT_DASHBOARD_ENABLED),
      port: envInt("ELIZAOK_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT, 1_024),
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
