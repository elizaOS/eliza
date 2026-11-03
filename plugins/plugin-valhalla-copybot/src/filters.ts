import { computeCosts } from "./cost-model.ts";
import { LIMITS, type Limits } from "./limits.ts";

const BLOCKED_MINTS = new Set([
  "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
  "GwdwQJb1marsG8xq25dgtFR5CeZCBHrFYa3N5bLUpump",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
  "HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM",
]);

const NAME_RE =
  /\b(usd[a-z0-9]*|usdt|usdc|usde|usds|pyusd|dai|frax|lusd|susd|tusd|gusd|busd|eurc|eurs|cash|stable|pegged|peg)\b/i;
const SYMBOL_RE = /^(usd[a-z0-9]*|usdt|usdc|usde|usds|pyusd|dai|frax|lusd|cash|eurc)$/i;

export function stableRejectReason(
  mint: string,
  symbol?: string | null,
  name?: string | null,
  pair?: { h1?: number | null; h6?: number | null; h24?: number | null } | null
): string | null {
  if (BLOCKED_MINTS.has(mint)) return `stablecoin blocklist (${symbol || mint.slice(0, 8)})`;
  const sym = String(symbol ?? "").trim();
  const label = String(name ?? "").trim();
  if ((sym && (SYMBOL_RE.test(sym) || NAME_RE.test(sym))) || (label && NAME_RE.test(label))) {
    return `stable-like name/symbol (${sym || label})`;
  }
  if (pair) {
    const h1 = Math.abs(Number(pair.h1 ?? 0));
    const h6 = Math.abs(Number(pair.h6 ?? 0));
    const h24 = Math.abs(Number(pair.h24 ?? 0));
    if ((h1 < 2 && h6 < 4) || (h1 < 2 && h24 < 3)) {
      return `dead peg (~${h1.toFixed(2)}% 1h range)`;
    }
  }
  return null;
}

export interface McapClass {
  ok: boolean;
  band: string;
  sizeFrac: number;
  reason: string;
  mcap: number;
}

export function classifyMcap(
  mcap: number,
  input: {
    change5m?: number;
    change1h?: number;
    vol1h?: number;
    vol24?: number;
    early?: boolean;
  } = {},
  limits: Limits = LIMITS
): McapClass {
  const mc = Number(mcap) || 0;
  const early = input.early === true;
  const min = early ? limits.earlyMcapMinUsd : limits.mcapMinUsd;
  const max = limits.maxMcapUsd;
  const prefMin = limits.mcapPreferredMinUsd;
  const prefMax = Math.min(limits.mcapPreferredMaxUsd, max);
  const half = limits.mcapSizeFracLow;
  const change5m = input.change5m ?? 0;
  const change1h = input.change1h ?? 0;
  const vol1h = input.vol1h ?? 0;
  const vol24 = input.vol24 ?? 0;
  if (mc > 0 && mc < min) {
    return {
      ok: false,
      band: "below_min",
      sizeFrac: 0,
      reason: `mcap $${Math.round(mc)} < min $${min}`,
      mcap: mc,
    };
  }
  if (mc > max) {
    return {
      ok: false,
      band: "above_max",
      sizeFrac: 0,
      reason: `mcap ${Math.round(mc)} > max $${Math.round(max)} (small-cap focus)`,
      mcap: mc,
    };
  }
  if (!mc) {
    if (early) {
      return {
        ok: true,
        band: "early_unknown",
        sizeFrac: half,
        reason: "early/bonding mcap unknown",
        mcap: 0,
      };
    }
    const strong = change5m > 5 || change1h > 15 || vol24 > 50_000;
    if (!strong) {
      return {
        ok: false,
        band: "unknown",
        sizeFrac: 0,
        reason: "mcap unknown + weak momentum",
        mcap: 0,
      };
    }
    return {
      ok: true,
      band: "low",
      sizeFrac: half,
      reason: "mcap unknown, strong momentum half-size",
      mcap: 0,
    };
  }
  if (early && mc >= min && mc < prefMin) {
    return {
      ok: true,
      band: "early_small",
      sizeFrac: half,
      reason: `early small mcap $${Math.round(mc)}`,
      mcap: mc,
    };
  }
  if (mc >= prefMin && mc <= prefMax) {
    return { ok: true, band: "preferred", sizeFrac: 1, reason: "preferred band", mcap: mc };
  }
  if (mc >= min && mc < prefMin) {
    const strong = change5m >= 8 || change1h >= 25 || (vol1h > 0 && vol1h / mc >= 0.15);
    if (!strong) {
      return {
        ok: false,
        band: "low",
        sizeFrac: 0,
        reason: `mcap $${Math.round(mc)} in the low band needs strong momentum`,
        mcap: mc,
      };
    }
    return {
      ok: true,
      band: "low",
      sizeFrac: half,
      reason: "low band half-size + momentum",
      mcap: mc,
    };
  }
  const strong = change5m >= 5 || change1h >= 20 || (vol1h > 0 && vol1h / mc >= 0.08);
  if (!strong) {
    return {
      ok: false,
      band: "large",
      sizeFrac: 0,
      reason: `mcap $${Math.round(mc)} needs strong momentum`,
      mcap: mc,
    };
  }
  return { ok: true, band: "large", sizeFrac: half, reason: "large band half-size", mcap: mc };
}

export function pairAgeMs(
  pairCreatedAt: number | string | null | undefined,
  now = Date.now()
): number | null {
  if (pairCreatedAt == null || pairCreatedAt === "") return null;
  const parsed =
    typeof pairCreatedAt === "number"
      ? pairCreatedAt < 1e12
        ? pairCreatedAt * 1000
        : pairCreatedAt
      : Date.parse(pairCreatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

export interface RecencyScore {
  score: number;
  reject: boolean;
  reason: string;
  pairAge: number | null;
}

export function scoreRecency(
  input: {
    pairCreatedAt?: number | string | null;
    vol1h?: number;
    vol6h?: number;
    vol24?: number;
    change5m?: number;
    change1h?: number;
    now?: number;
  },
  limits: Limits = LIMITS
): RecencyScore {
  const now = input.now ?? Date.now();
  const age = pairAgeMs(input.pairCreatedAt, now);
  let score = 0;
  let reject = false;
  let reason = "";
  if (age != null && age > limits.recencyHardMaxAgeMs) {
    return {
      score: -100,
      reject: true,
      reason: `pair age ${(age / 86_400_000).toFixed(1)}d > 3d`,
      pairAge: age,
    };
  }
  if (age != null && age <= limits.recencyPairMaxAgeMs) {
    score += 35;
    if (age <= limits.recencyWindowMs) score += 20;
  } else if (age != null && age > limits.recencyPairMaxAgeMs) {
    score -= 25;
    reason = `pair age >24h (${(age / 3_600_000).toFixed(0)}h)`;
  }
  const change5m = input.change5m ?? 0;
  const change1h = input.change1h ?? 0;
  if (change5m >= 3 && change5m <= 30) score += 15;
  if (change1h >= 10 && change1h <= 80) score += 10;
  if (change5m > 0 && change1h > 0 && change5m * 12 >= change1h * 0.5) score += 10;
  const vol1h = input.vol1h ?? 0;
  const vol6h = input.vol6h ?? 0;
  const vol24 = input.vol24 ?? 0;
  const prior = vol6h > 0 ? vol6h / 6 : vol24 > 0 ? vol24 / 24 : 0;
  if (vol1h > 0 && prior > 0) {
    const ratio = vol1h / prior;
    if (ratio < limits.recencyFadeVolRatio && change5m <= 0) {
      score -= 30;
      reject = ratio < limits.recencyFadeVolRatio * 0.7;
      reason = `fading wave vol1h/prior=${ratio.toFixed(2)}`;
    } else if (ratio >= 1.2) {
      score += 15;
    }
  }
  return { score, reject, reason, pairAge: age };
}

export function buySellRatio(
  buys: number | null | undefined,
  sells: number | null | undefined
): number | null {
  if (buys == null || sells == null || !Number.isFinite(buys) || !Number.isFinite(sells))
    return null;
  if (sells === 0) return buys > 0 ? Number.POSITIVE_INFINITY : 0;
  return buys / sells;
}

export function liquidityFloorUsd(bonding: boolean, limits: Limits = LIMITS): number {
  return bonding ? limits.bondingMinLiquidityUsd : limits.minLiquidityUsd;
}

export interface RugSummary {
  score?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  risks?: Array<{
    level?: string | null;
    name?: string | null;
    value?: number | null;
    pct?: number | null;
  }>;
  topHolders?: Array<{ pct?: number | null; address?: string | null; owner?: string | null }>;
  markets?: Array<{ lp?: { lpLockedPct?: number | null } | null }>;
  rugged?: boolean;
  creator?: string | null;
  creatorTokens?: Array<{
    mint?: string;
    rugged?: boolean;
    marketCap?: number;
    mcap?: number;
    createdAt?: string;
  }>;
}

export interface MrRow {
  safetyScore?: number | null;
  blacklisted?: boolean;
  bundleRisk?: string | null;
  found?: boolean;
}

export function judgeRugcheck(
  report: RugSummary | null,
  mint: string,
  limits: Limits = LIMITS
): { ok: boolean; reason: string } {
  if (!report) return { ok: false, reason: "unavailable" };
  if (report.mintAuthority) return { ok: false, reason: "mint authority" };
  if (report.freezeAuthority) return { ok: false, reason: "freeze authority" };
  const risks = report.risks ?? [];
  const danger = risks.filter((risk) => {
    const level = String(risk.level ?? "").toLowerCase();
    const name = String(risk.name ?? "").toLowerCase();
    return level === "danger" || name.includes("danger");
  });
  if (danger.length > 0) {
    return {
      ok: false,
      reason: `danger: ${danger
        .map((risk) => risk.name)
        .slice(0, 3)
        .join(",")}`,
    };
  }
  const top = (report.topHolders ?? [])
    .slice(0, 10)
    .reduce((sum, holder) => sum + Number(holder.pct ?? 0), 0);
  const topPct = top > 1.5 ? top / 100 : top;
  if (topPct > 0.4) return { ok: false, reason: `top10 ${(topPct * 100).toFixed(0)}%` };
  const score = Number(report.score ?? 0);
  if (score > limits.prebuyRugcheckMaxScore && score > 10_000) {
    return { ok: false, reason: `score ${score}` };
  }
  const lp = report.markets?.[0];
  const locked = lp?.lp?.lpLockedPct;
  if (lp && locked != null && Number(locked) < 5 && !/pump/i.test(mint)) {
    const names = risks.map((risk) => (risk.name ?? "").toLowerCase()).join(" ");
    if (names.includes("lp") || names.includes("liquidity"))
      return { ok: false, reason: "LP not locked" };
  }
  return { ok: true, reason: `score=${score}` };
}

export function judgeMemeRunners(
  row: MrRow | null,
  limits: Limits = LIMITS
): { ok: boolean; reason: string } {
  if (!row || row.found === false) return { ok: false, reason: "not scanned" };
  if (row.blacklisted) return { ok: false, reason: "blacklisted" };
  const safety = Number(row.safetyScore ?? 0);
  if (safety < limits.prebuyMrMinSafety) return { ok: false, reason: `safety ${safety}` };
  if (String(row.bundleRisk ?? "").toLowerCase() === "high")
    return { ok: false, reason: "bundle high" };
  return { ok: true, reason: `safety=${safety}` };
}

/** Fail closed unless RugCheck or Meme Runners passes. */
export function judgePrebuy(
  mint: string,
  rug: RugSummary | null,
  mr: MrRow | null,
  limits: Limits = LIMITS
): { ok: boolean; passedVia: "rugcheck" | "mr" | null; reason: string } {
  const rugJudgement = judgeRugcheck(rug, mint, limits);
  const mrJudgement = judgeMemeRunners(mr, limits);
  if (rugJudgement.ok) return { ok: true, passedVia: "rugcheck", reason: rugJudgement.reason };
  if (mrJudgement.ok) return { ok: true, passedVia: "mr", reason: mrJudgement.reason };
  return {
    ok: false,
    passedVia: null,
    reason: `rug:${rugJudgement.reason} mr:${mrJudgement.reason}`,
  };
}

export function isRuggedPrior(
  token: { mint?: string; rugged?: boolean; marketCap?: number; mcap?: number; createdAt?: string },
  currentMint: string,
  now = Date.now(),
  limits: Limits = LIMITS
): boolean {
  if (!token.mint || token.mint === currentMint) return false;
  if (token.rugged === true) return true;
  const mcap = Number(token.marketCap ?? token.mcap ?? 0);
  const created = token.createdAt ? Date.parse(token.createdAt) : 0;
  const ageMs = created ? now - created : 0;
  if (ageMs >= 24 * 60 * 60 * 1000 && mcap > 0 && mcap < limits.creatorPriorRugMcapMaxUsd)
    return true;
  if (ageMs >= 24 * 60 * 60 * 1000 && mcap === 0) return true;
  return false;
}

export function creatorRugReason(
  mint: string,
  report: RugSummary | null,
  now = Date.now(),
  limits: Limits = LIMITS
): string | null {
  if (report?.rugged === true) return "token marked rugged on RugCheck";
  const risks = (report?.risks ?? [])
    .map((risk) => `${risk.name ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (/rugged creator|creator.*rug|previous.*rug/i.test(risks))
    return "creator rug history (RugCheck risk)";
  const priors = (report?.creatorTokens ?? []).filter((token) =>
    isRuggedPrior(token, mint, now, limits)
  );
  if (priors.length >= 1) return `creator has ${priors.length} prior low-mcap/rugged token(s)`;
  return null;
}

export function expectedStopRealized(input: {
  slPct: number;
  sellImpactPct: number;
  ticketSol: number;
  exitFeePct?: number | null;
}): { expectedRealizedPct: number } {
  const stopAbs = Math.abs(Number(input.slPct) || 0);
  const sellImp = Math.max(0, Number(input.sellImpactPct) || 0);
  const feePct = Math.max(0, Number(input.exitFeePct) || 0);
  return { expectedRealizedPct: stopAbs + sellImp + feePct };
}

export function shouldRejectForSlippage(
  input: {
    slPct: number;
    sellImpactPct?: number | null;
    buyImpactPct?: number | null;
    ticketSol: number;
    liquidityUsd?: number | null;
    solUsd?: number | null;
  },
  limits: Limits = LIMITS
): { reject: boolean; reason: string | null; expectedRealizedPct: number } {
  const costs = computeCosts(
    {
      ticketSol: input.ticketSol,
      buyImpactPct: input.buyImpactPct,
      sellImpactPct: input.sellImpactPct,
      liquidityUsd: input.liquidityUsd,
      solUsd: input.solUsd,
    },
    limits
  );
  const est = expectedStopRealized({
    slPct: input.slPct,
    sellImpactPct: costs.sellLegPct,
    ticketSol: input.ticketSol,
    exitFeePct: costs.exitFeePct,
  });
  if (est.expectedRealizedPct > limits.slippageStopMaxRealizedPct + 1e-12) {
    return {
      reject: true,
      reason: `stop+slip+fees ${(est.expectedRealizedPct * 100).toFixed(1)}% > ${(limits.slippageStopMaxRealizedPct * 100).toFixed(0)}% cap (${costs.sellLegVia})`,
      expectedRealizedPct: est.expectedRealizedPct,
    };
  }
  return { reject: false, reason: null, expectedRealizedPct: est.expectedRealizedPct };
}

export function windowNetGate(
  ticketSol: number,
  costs: { allInRtPct: number },
  limits: Limits = LIMITS
): { reject: boolean; reason: string | null } {
  const netAtTp = limits.windowsMinTpPct - costs.allInRtPct;
  if (netAtTp + 1e-12 < limits.windowsMinNetAtTpPct) {
    return {
      reject: true,
      reason: `+${(limits.windowsMinTpPct * 100).toFixed(0)}% TP nets ${(netAtTp * 100).toFixed(1)}% after costs < ${(limits.windowsMinNetAtTpPct * 100).toFixed(0)}%`,
    };
  }
  return { reject: false, reason: null };
}

export function bankLamports(freeSol: number, openCostSol: number): number {
  return Math.floor((freeSol + openCostSol) * 1e9);
}

/** Blocks new entries only. Exits stay on. Unknown balance fails closed. */
export function bankFloorBlocks(
  freeSol: number | null | undefined,
  openCostSol: number,
  limits: Limits = LIMITS
): boolean {
  if (!Number.isFinite(limits.bankFloorLamports) || limits.bankFloorLamports <= 0) return false;
  if (freeSol == null) return true;
  return bankLamports(freeSol, openCostSol) <= limits.bankFloorLamports;
}

export function dailyLossTripped(
  equitySol: number,
  dayStartEquitySol: number,
  limits: Limits = LIMITS
): boolean {
  if (!(dayStartEquitySol > 0) || !(equitySol > 0)) return false;
  return equitySol <= dayStartEquitySol * (1 - limits.dailyLossCapPct);
}

export function walletWinRateReject(
  winRate: number | null | undefined,
  closedTrades: number | null | undefined,
  limits: Limits = LIMITS
): string | null {
  if (winRate == null && closedTrades == null) return null;
  const trades = Number(closedTrades ?? 0);
  if (trades < limits.minWalletWinRateTrades) return null;
  if (!Number.isFinite(Number(winRate)) || Number(winRate) < limits.minWalletWinRate) {
    return `wallet win rate ${winRate ?? "unknown"} < ${limits.minWalletWinRate} over ${trades} trades`;
  }
  return null;
}
