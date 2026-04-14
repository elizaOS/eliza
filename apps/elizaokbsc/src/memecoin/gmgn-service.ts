/**
 * Market Intelligence API Service
 *
 * Provides real-time holder tracking, KOL detection, and top-holder
 * monitoring for active positions.  Feeds smart exit signals into
 * both the main portfolio and paper Goo agents.
 */

const GMGN_API_BASE = "https://gmgn.ai/api/v1";
const GMGN_API_KEY = process.env.GMGN_API_KEY || "gmgn_d9ff9fa4f123187160b68230498428f0";
const CHAIN = "bsc";

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

function apiUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${GMGN_API_BASE}${path}${sep}api_key=${GMGN_API_KEY}`;
}

/* ─── Types ───────────────────────────────────────────────────────── */

export interface HolderSnapshot {
  tokenAddress: string;
  timestamp: string;
  holderCount: number;
  top10HoldPct: number;
}

export interface HolderDelta {
  tokenAddress: string;
  previous: HolderSnapshot;
  current: HolderSnapshot;
  holderChange: number;
  holderChangePct: number;
  top10HoldPctChange: number;
  elapsedMs: number;
  alert: "none" | "warning" | "critical";
  alertReason: string;
}

export interface KolHolder {
  address: string;
  tag: string;
  amountUsd: number;
  percentOfSupply: number;
  buyTimestamp: string | null;
}

export interface KolSignal {
  tokenAddress: string;
  kolCount: number;
  kolHolders: KolHolder[];
  totalKolUsd: number;
  timestamp: string;
}

export interface TopHolder {
  address: string;
  balance: number;
  percentOfSupply: number;
  tag: string | null;
}

export interface TopHolderSnapshot {
  tokenAddress: string;
  timestamp: string;
  holders: TopHolder[];
  totalTopHoldPct: number;
}

export interface TopHolderDelta {
  tokenAddress: string;
  previous: TopHolderSnapshot;
  current: TopHolderSnapshot;
  totalPctChange: number;
  exitedHolders: string[];
  reducedHolders: Array<{ address: string; pctDrop: number }>;
  alert: "none" | "warning" | "critical";
  alertReason: string;
}

export interface SmartExitSignal {
  tokenAddress: string;
  tokenSymbol: string;
  timestamp: string;
  signalType: "holder_drop" | "kol_exit" | "top_holder_dump" | "none";
  severity: "none" | "warning" | "critical";
  reason: string;
  shouldExit: boolean;
  details: {
    holderDelta?: HolderDelta;
    kolSignal?: KolSignal;
    topHolderDelta?: TopHolderDelta;
  };
}

/* ─── In-memory cache for deltas ──────────────────────────────────── */

const holderCache = new Map<string, HolderSnapshot>();
const topHolderCache = new Map<string, TopHolderSnapshot>();

/* ─── API Fetchers ────────────────────────────────────────────────── */

async function safeFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchHolderCount(tokenAddress: string): Promise<HolderSnapshot | null> {
  const data = await safeFetch(
    apiUrl(`/token_holder_stat/${CHAIN}/${tokenAddress}`)
  );
  if (!data?.data) return null;

  const stats = data.data;
  const holderCount = stats.holder_count ?? stats.total_holders ?? 0;
  const top10 = stats.top_10_holder_rate ?? stats.top10_hold_pct ?? 0;

  return {
    tokenAddress,
    timestamp: new Date().toISOString(),
    holderCount,
    top10HoldPct: typeof top10 === "number" ? top10 * 100 : 0,
  };
}

export async function fetchKolHolders(tokenAddress: string): Promise<KolSignal | null> {
  const data = await safeFetch(
    apiUrl(`/token_kol_list/${CHAIN}/${tokenAddress}`)
  );
  if (!data?.data) return null;

  const kols: KolHolder[] = (data.data || []).map((k: any) => ({
    address: k.address || k.wallet_address || "",
    tag: k.tag || k.name || "KOL",
    amountUsd: k.usd_value || k.amount_usd || 0,
    percentOfSupply: (k.pnl_percent || k.percent_of_supply || 0) * 100,
    buyTimestamp: k.buy_timestamp || k.first_buy_time || null,
  }));

  return {
    tokenAddress,
    kolCount: kols.length,
    kolHolders: kols,
    totalKolUsd: kols.reduce((sum, k) => sum + k.amountUsd, 0),
    timestamp: new Date().toISOString(),
  };
}

export async function fetchTopHolders(tokenAddress: string): Promise<TopHolderSnapshot | null> {
  const data = await safeFetch(
    apiUrl(`/token_top_holders/${CHAIN}/${tokenAddress}?limit=10`)
  );
  if (!data?.data) return null;

  const holders: TopHolder[] = (data.data || []).map((h: any) => ({
    address: h.address || h.wallet_address || "",
    balance: h.balance || h.amount || 0,
    percentOfSupply: (h.percent_of_supply || h.pct || 0) * 100,
    tag: h.tag || h.name || null,
  }));

  const totalPct = holders.reduce((sum, h) => sum + h.percentOfSupply, 0);

  return {
    tokenAddress,
    timestamp: new Date().toISOString(),
    holders,
    totalTopHoldPct: totalPct,
  };
}

/* ─── Delta computation ───────────────────────────────────────────── */

export function computeHolderDelta(
  tokenAddress: string,
  current: HolderSnapshot,
  criticalThreshold: number = 10,
  warningThreshold: number = 5,
): HolderDelta {
  const previous = holderCache.get(tokenAddress);
  holderCache.set(tokenAddress, current);

  if (!previous) {
    return {
      tokenAddress,
      previous: current,
      current,
      holderChange: 0,
      holderChangePct: 0,
      top10HoldPctChange: 0,
      elapsedMs: 0,
      alert: "none",
      alertReason: "First snapshot",
    };
  }

  const elapsedMs = new Date(current.timestamp).getTime() - new Date(previous.timestamp).getTime();
  const holderChange = current.holderCount - previous.holderCount;
  const holderChangePct = previous.holderCount > 0
    ? (holderChange / previous.holderCount) * 100
    : 0;
  const top10Change = current.top10HoldPct - previous.top10HoldPct;

  let alert: HolderDelta["alert"] = "none";
  let alertReason = "";

  if (holderChange <= -criticalThreshold) {
    alert = "critical";
    alertReason = `Lost ${Math.abs(holderChange)} holders (${holderChangePct.toFixed(1)}%) in ${Math.round(elapsedMs / 1000)}s`;
  } else if (holderChange <= -warningThreshold) {
    alert = "warning";
    alertReason = `Lost ${Math.abs(holderChange)} holders in ${Math.round(elapsedMs / 1000)}s`;
  }

  return { tokenAddress, previous, current, holderChange, holderChangePct, top10HoldPctChange: top10Change, elapsedMs, alert, alertReason };
}

export function computeTopHolderDelta(
  tokenAddress: string,
  current: TopHolderSnapshot,
  dumpThresholdPct: number = 15,
): TopHolderDelta {
  const previous = topHolderCache.get(tokenAddress);
  topHolderCache.set(tokenAddress, current);

  if (!previous) {
    return {
      tokenAddress,
      previous: current,
      current,
      totalPctChange: 0,
      exitedHolders: [],
      reducedHolders: [],
      alert: "none",
      alertReason: "First snapshot",
    };
  }

  const totalPctChange = current.totalTopHoldPct - previous.totalTopHoldPct;
  const prevAddrs = new Set(previous.holders.map(h => h.address));
  const currAddrs = new Set(current.holders.map(h => h.address));

  const exitedHolders = previous.holders
    .filter(h => !currAddrs.has(h.address))
    .map(h => h.address);

  const reducedHolders: Array<{ address: string; pctDrop: number }> = [];
  for (const prev of previous.holders) {
    const curr = current.holders.find(h => h.address === prev.address);
    if (curr && prev.percentOfSupply > 0) {
      const drop = prev.percentOfSupply - curr.percentOfSupply;
      if (drop > 1) {
        reducedHolders.push({ address: prev.address, pctDrop: drop });
      }
    }
  }

  let alert: TopHolderDelta["alert"] = "none";
  let alertReason = "";

  if (totalPctChange <= -dumpThresholdPct || exitedHolders.length >= 2) {
    alert = "critical";
    alertReason = `Top holders dumped: ${totalPctChange.toFixed(1)}% supply change, ${exitedHolders.length} exited`;
  } else if (reducedHolders.length >= 3 || totalPctChange <= -(dumpThresholdPct / 2)) {
    alert = "warning";
    alertReason = `${reducedHolders.length} top holders reducing positions`;
  }

  return { tokenAddress, previous, current, totalPctChange, exitedHolders, reducedHolders, alert, alertReason };
}

/* ─── Smart exit signal aggregator ────────────────────────────────── */

export async function evaluateSmartExit(
  tokenAddress: string,
  tokenSymbol: string,
  config: {
    holderDropCritical?: number;
    holderDropWarning?: number;
    topHolderDumpPct?: number;
    minKolForSafety?: number;
  } = {},
): Promise<SmartExitSignal> {
  const now = new Date().toISOString();
  const holderCritical = config.holderDropCritical ?? 10;
  const holderWarning = config.holderDropWarning ?? 5;
  const topDumpPct = config.topHolderDumpPct ?? 15;
  const minKol = config.minKolForSafety ?? 2;

  const [holderSnap, kolSignal, topSnap] = await Promise.all([
    fetchHolderCount(tokenAddress),
    fetchKolHolders(tokenAddress),
    fetchTopHolders(tokenAddress),
  ]);

  const details: SmartExitSignal["details"] = {};

  // Holder attrition
  let holderDelta: HolderDelta | undefined;
  if (holderSnap) {
    holderDelta = computeHolderDelta(tokenAddress, holderSnap, holderCritical, holderWarning);
    details.holderDelta = holderDelta;
  }

  // KOL signal
  if (kolSignal) {
    details.kolSignal = kolSignal;
  }

  // Top holder delta
  let topDelta: TopHolderDelta | undefined;
  if (topSnap) {
    topDelta = computeTopHolderDelta(tokenAddress, topSnap, topDumpPct);
    details.topHolderDelta = topDelta;
  }

  // Determine exit signal
  if (holderDelta?.alert === "critical") {
    return {
      tokenAddress, tokenSymbol, timestamp: now,
      signalType: "holder_drop", severity: "critical",
      reason: holderDelta.alertReason, shouldExit: true, details,
    };
  }

  if (topDelta?.alert === "critical") {
    return {
      tokenAddress, tokenSymbol, timestamp: now,
      signalType: "top_holder_dump", severity: "critical",
      reason: topDelta.alertReason, shouldExit: true, details,
    };
  }

  // KOL exit: if we had KOLs before but they're gone
  if (kolSignal && kolSignal.kolCount < minKol) {
    const prevKol = kolSignal.kolCount;
    if (prevKol === 0 && minKol > 0) {
      return {
        tokenAddress, tokenSymbol, timestamp: now,
        signalType: "kol_exit", severity: "warning",
        reason: `No KOLs holding (need >= ${minKol})`,
        shouldExit: false, details,
      };
    }
  }

  if (holderDelta?.alert === "warning" || topDelta?.alert === "warning") {
    const reason = holderDelta?.alert === "warning"
      ? holderDelta.alertReason
      : topDelta?.alertReason || "Warning";
    return {
      tokenAddress, tokenSymbol, timestamp: now,
      signalType: holderDelta?.alert === "warning" ? "holder_drop" : "top_holder_dump",
      severity: "warning", reason, shouldExit: false, details,
    };
  }

  return {
    tokenAddress, tokenSymbol, timestamp: now,
    signalType: "none", severity: "none",
    reason: "No exit signals", shouldExit: false, details,
  };
}

/* ─── Batch evaluation for portfolio ──────────────────────────────── */

export interface PortfolioExitScan {
  timestamp: string;
  scannedCount: number;
  exitSignals: SmartExitSignal[];
  criticalCount: number;
  warningCount: number;
}

export async function scanPortfolioForExits(
  positions: Array<{ tokenAddress: string; tokenSymbol: string }>,
  config?: Parameters<typeof evaluateSmartExit>[2],
): Promise<PortfolioExitScan> {
  const signals: SmartExitSignal[] = [];

  // Process sequentially to avoid rate limits
  for (const pos of positions) {
    const signal = await evaluateSmartExit(pos.tokenAddress, pos.tokenSymbol, config);
    signals.push(signal);
    // Small delay between API calls
    await new Promise(r => setTimeout(r, 300));
  }

  return {
    timestamp: new Date().toISOString(),
    scannedCount: positions.length,
    exitSignals: signals,
    criticalCount: signals.filter(s => s.severity === "critical").length,
    warningCount: signals.filter(s => s.severity === "warning").length,
  };
}

/* ─── KOL profit tracking (reverse-engineer their TP) ─────────────── */

export interface KolProfitProfile {
  address: string;
  tag: string;
  avgTakeProfitPct: number;
  medianTakeProfitPct: number;
  tradeCount: number;
  winRate: number;
  avgHoldTimeHours: number;
}

export async function fetchKolTrades(walletAddress: string): Promise<any[]> {
  const data = await safeFetch(
    apiUrl(`/wallet_activity/${CHAIN}?type=buy&type=sell&wallet=${walletAddress}&limit=50`)
  );
  return data?.data?.activities || data?.data || [];
}

export async function profileKolStrategy(walletAddress: string, tag: string = "KOL"): Promise<KolProfitProfile | null> {
  const trades = await fetchKolTrades(walletAddress);
  if (!trades || trades.length < 4) return null;

  const buys = new Map<string, { price: number; time: number }>();
  const profits: number[] = [];
  const holdTimes: number[] = [];
  let wins = 0;
  let total = 0;

  for (const t of trades) {
    const token = t.token_address || t.contract_address || "";
    const side = t.event_type || t.type || "";
    const price = t.price || t.price_usd || 0;
    const time = t.timestamp ? new Date(t.timestamp).getTime() : 0;

    if (side === "buy" || side === "Buy") {
      buys.set(token, { price, time });
    } else if ((side === "sell" || side === "Sell") && buys.has(token)) {
      const buy = buys.get(token)!;
      if (buy.price > 0) {
        const pnlPct = ((price - buy.price) / buy.price) * 100;
        profits.push(pnlPct);
        if (pnlPct > 0) wins++;
        total++;
        if (time > 0 && buy.time > 0) {
          holdTimes.push((time - buy.time) / 3600000);
        }
      }
      buys.delete(token);
    }
  }

  if (profits.length < 2) return null;

  const sorted = [...profits].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const avg = profits.reduce((s, v) => s + v, 0) / profits.length;
  const avgHold = holdTimes.length > 0
    ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length
    : 0;

  return {
    address: walletAddress,
    tag,
    avgTakeProfitPct: avg,
    medianTakeProfitPct: median,
    tradeCount: total,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    avgHoldTimeHours: avgHold,
  };
}
