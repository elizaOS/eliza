export const ELIZAOK_DISCOVERY_TASK = "elizaok_bnb_discovery_cycle";

export const GECKO_TERMINAL_API_BASE = "https://api.geckoterminal.com/api/v2";
export const GECKO_TERMINAL_NETWORK = "bsc";

export const DEFAULT_DISCOVERY_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_NEW_POOLS_LIMIT = 20;
export const DEFAULT_TRENDING_POOLS_LIMIT = 10;
export const DEFAULT_MAX_CANDIDATES = 12;
export const DEFAULT_MEMO_TOP_COUNT = 3;
export const DEFAULT_REPORTS_DIR = ".elizaok/reports";
export const DEFAULT_RUN_ON_STARTUP = true;
export const DEFAULT_DASHBOARD_ENABLED = true;
export const DEFAULT_DASHBOARD_PORT = 4048;
export const DEFAULT_GOO_LOOKBACK_BLOCKS = 25_000;
export const DEFAULT_GOO_MAX_AGENTS = 20;
export const DEFAULT_GOO_MEMO_TOP_COUNT = 3;

export const TARGET_EARLY_MCAP_USD = 50_000;
export const DEFAULT_QUOTE_TOKEN_ADDRESSES = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "0x0000000000000000000000000000000000000000",
]);

export const ELIZAOK_SCAN_RUNS_TABLE = "elizaok_scan_runs";
export const ELIZAOK_CANDIDATE_TABLE = "elizaok_candidate_snapshots";
export const ELIZAOK_MEMO_TABLE = "elizaok_scan_memos";
export const ELIZAOK_GOO_TABLE = "elizaok_goo_candidates";
