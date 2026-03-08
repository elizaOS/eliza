/**
 * @elizaos/plugin-abu-solana
 *
 * Abu — Autonomous Solana DeFi Agent plugin for ElizaOS.
 * Provides real-time arbitrage signals, market analysis,
 * reputation scoring, and trading signal actions.
 */

const ABU_BASE_URL = "https://www.aiabu.club/api/public";

interface AbuArbScan {
  file: string;
  content: string;
}

interface AbuMarketData {
  sol_price_usd: number;
  sol_price_24h_change_pct: number;
  solana_chain_tvl: number;
  solana_chain_tvl_change_pct: number;
  protocol_tvls: Record<string, { tvl: number; change_1d_pct: number }>;
  new_pools_count: number;
  birdeye_trending_count: number;
  birdeye_trending?: Array<{
    symbol: string;
    name: string;
    price: number;
    price_change_24h: number;
  }>;
  fetched_at: string;
  stale: boolean;
}

interface AbuReputation {
  score: number;
  uptime_days: number;
  trade_success_rate: number;
  signal_quality: number;
  collab_credit: number;
  broadcast_accuracy: number;
  last_updated: string;
  history: Array<{ date: string; score: number }>;
}

async function fetchAbu<T>(path: string): Promise<T> {
  const resp = await fetch(`${ABU_BASE_URL}${path}`);
  if (!resp.ok) {
    throw new Error(`Abu API error: HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

// ─── Actions ─────────────────────────────────────────

const abuArbScanAction = {
  name: "ABU_ARB_SCAN",
  description:
    "Get recent Solana DEX arbitrage scan results from Abu (25+ token pairs via Jupiter aggregator)",
  similes: [
    "check arbitrage",
    "arb opportunities",
    "dex spread",
    "solana arbitrage",
  ],
  validate: async (): Promise<boolean> => true,
  handler: async (): Promise<string> => {
    const data = await fetchAbu<{ arb_scans: AbuArbScan[]; count: number }>(
      "/arb"
    );
    const scans = data.arb_scans ?? [];
    if (scans.length === 0) return "No recent arbitrage scans available.";
    const summary = scans
      .map((s) => `${s.file}: ${s.content.substring(0, 120)}`)
      .join("\n");
    return `Abu Arbitrage Scan (${scans.length} results):\n${summary}`;
  },
  examples: [
    [
      {
        user: "user1",
        content: { text: "Check Solana arbitrage opportunities" },
      },
      {
        user: "abu",
        content: { text: "Scanning 25+ Solana token pairs for arbitrage..." },
      },
    ],
  ],
};

const abuMarketDataAction = {
  name: "ABU_MARKET_DATA",
  description:
    "Get multi-source Solana market data from Abu (CoinGecko, DeFiLlama, Birdeye)",
  similes: ["market data", "sol price", "defi tvl", "solana market"],
  validate: async (): Promise<boolean> => true,
  handler: async (): Promise<string> => {
    const data = await fetchAbu<AbuMarketData>("/market");
    const price = data.sol_price_usd?.toFixed(2) ?? "?";
    const change = data.sol_price_24h_change_pct?.toFixed(1) ?? "?";
    const tvl = data.solana_chain_tvl
      ? (data.solana_chain_tvl / 1e9).toFixed(2)
      : "?";
    return (
      `Solana Market Data:\n` +
      `  SOL: $${price} (${change}%)\n` +
      `  Chain TVL: $${tvl}B\n` +
      `  Birdeye Trending: ${data.birdeye_trending_count ?? 0} tokens\n` +
      `  Data stale: ${data.stale ? "Yes" : "No"}`
    );
  },
  examples: [
    [
      {
        user: "user1",
        content: { text: "What's the Solana market looking like?" },
      },
      {
        user: "abu",
        content: { text: "SOL: $142.50 (+2.3%), Chain TVL: $12.5B" },
      },
    ],
  ],
};

const abuReputationAction = {
  name: "ABU_REPUTATION",
  description:
    "Get Abu's on-chain reputation score (5 dimensions: uptime, trades, signals, collaboration, broadcasts)",
  similes: ["reputation", "trust score", "agent rating"],
  validate: async (): Promise<boolean> => true,
  handler: async (): Promise<string> => {
    const data = await fetchAbu<AbuReputation>("/reputation");
    const successPct = ((data.trade_success_rate ?? 0) * 100).toFixed(0);
    return (
      `Abu Reputation: ${data.score}/100\n` +
      `  Uptime: ${data.uptime_days} days\n` +
      `  Trade Success: ${successPct}%\n` +
      `  Signal Quality: ${data.signal_quality}/100\n` +
      `  Collaboration Credit: ${data.collab_credit}/100`
    );
  },
  examples: [],
};

const abuSignalsAction = {
  name: "ABU_SIGNALS",
  description:
    "Get Abu's trading signal stream (arbitrage opportunities, market alerts)",
  similes: ["trading signals", "buy signals", "market alerts"],
  validate: async (): Promise<boolean> => true,
  handler: async (): Promise<string> => {
    const data = await fetchAbu<{ signals: unknown[]; count: number }>(
      "/signals"
    );
    if (data.count === 0) return "No recent trading signals from Abu.";
    const recent = data.signals.slice(-5);
    return (
      `Abu Signals (${data.count} total, showing last ${recent.length}):\n` +
      recent.map((s) => JSON.stringify(s).substring(0, 150)).join("\n")
    );
  },
  examples: [],
};

// ─── Provider ────────────────────────────────────────

const abuSolanaProvider = {
  name: "ABU_SOLANA_PROVIDER",
  description: "Provides real-time Solana DeFi data from Abu autonomous agent",
  get: async (): Promise<string> => {
    try {
      const market = await fetchAbu<AbuMarketData>("/market");
      const price = market.sol_price_usd?.toFixed(2) ?? "?";
      const tvl = market.solana_chain_tvl
        ? (market.solana_chain_tvl / 1e9).toFixed(2)
        : "?";
      return `[Abu Solana Data] SOL=$${price} TVL=$${tvl}B`;
    } catch {
      return "[Abu] Market data temporarily unavailable";
    }
  },
};

// ─── Plugin Export ───────────────────────────────────

export const abuPlugin = {
  name: "@elizaos/plugin-abu-solana",
  description:
    "Abu - Autonomous Solana DeFi Agent providing arbitrage signals, market analysis, and on-chain reputation",
  actions: [
    abuArbScanAction,
    abuMarketDataAction,
    abuReputationAction,
    abuSignalsAction,
  ],
  providers: [abuSolanaProvider],
  evaluators: [],
};

export default abuPlugin;
