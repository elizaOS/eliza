import { computeCosts } from "./cost-model.ts";
import { exceedsRoundTripCap } from "./fees.ts";
import {
  bankFloorBlocks,
  buySellRatio,
  classifyMcap,
  creatorRugReason,
  dailyLossTripped,
  judgePrebuy,
  liquidityFloorUsd,
  type MrRow,
  pairAgeMs,
  type RugSummary,
  scoreRecency,
  shouldRejectForSlippage,
  stableRejectReason,
  walletWinRateReject,
  windowNetGate,
} from "./filters.ts";
import { type Lane, LIMITS, type Limits } from "./limits.ts";
import {
  badActorHit,
  devHoldReject,
  type HolderRow,
  judgeEarlyBuyers,
  type ParsedEarlyTx,
  rugRiskPct,
  top10ExLp,
} from "./manipulation.ts";
import { extraSafetyGate } from "./safety-score.ts";
import { applyMultipliers, chooseSize } from "./sizing.ts";
import { computeTicketSol } from "./slots.ts";

export interface CoinSnapshot {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  lane?: Lane;
  creator?: string | null;
  pairCreatedAt?: number | string | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  volume1hUsd?: number | null;
  volume5mUsd?: number | null;
  volume6hUsd?: number | null;
  change5mPct?: number | null;
  change1hPct?: number | null;
  change6hPct?: number | null;
  change24hPct?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  bondingCurve?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferHook?: boolean;
  holders?: HolderRow[];
  rug?: RugSummary | null;
  mr?: MrRow | null;
  earlyTxs?: ParsedEarlyTx[] | null;
  buyImpactPct?: number | null;
  sellImpactPct?: number | null;
  quoteSol?: number | null;
  walletWinRate?: number | null;
  walletClosedTrades?: number | null;
  pullbackFromHighPct?: number | null;
  signalAgeMs?: number | null;
  solUsd?: number | null;
  now?: number;
  badActors?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  allowCreatorUnknown?: boolean;
  equitySol?: number;
  freeSol?: number | null;
  openCostSol?: number;
  dayStartEquitySol?: number | null;
  cooldownUntil?: number | null;
  openSlotsUsed?: number;
  alreadyHeld?: boolean;
}

export interface Evaluation {
  ok: boolean;
  reason: string;
  lane: Lane;
  sizeSol: number;
  checks: string[];
}

function fail(reason: string, checks: string[], lane: Lane): Evaluation {
  return { ok: false, reason, lane, sizeSol: 0, checks };
}

export function evaluateCoin(snapshot: CoinSnapshot, limits: Limits = LIMITS): Evaluation {
  const checks: string[] = [];
  const now = snapshot.now ?? Date.now();
  const laneIn: Lane = snapshot.lane ?? "main";
  const stable = stableRejectReason(snapshot.mint, snapshot.symbol, snapshot.name, {
    h1: snapshot.change1hPct,
    h6: snapshot.change6hPct,
    h24: snapshot.change24hPct,
  });
  if (stable) return fail(stable, checks, laneIn);
  checks.push("stable");
  if (snapshot.mintAuthority) return fail("mint authority live", checks, laneIn);
  if (snapshot.freezeAuthority) return fail("freeze authority on", checks, laneIn);
  checks.push("authorities");
  if (snapshot.rug) {
    const gate = extraSafetyGate(snapshot.rug);
    if (!gate.ok) return fail(gate.reason, checks, laneIn);
    checks.push("connection-safety");
  }
  if (snapshot.transferHook) return fail("transfer hook blocks sells", checks, laneIn);
  checks.push("transfer-hook");
  if (snapshot.alreadyHeld) return fail("no average down", checks, laneIn);
  const age = pairAgeMs(snapshot.pairCreatedAt, now);
  const early = snapshot.bondingCurve === true || (age != null && age < limits.burnerMaxAgeMs);
  const liquidity = snapshot.liquidityUsd;
  if (liquidity == null || !Number.isFinite(liquidity))
    return fail("liquidity unknown", checks, laneIn);
  const liqFloor = liquidityFloorUsd(snapshot.bondingCurve === true, limits);
  if (liquidity < liqFloor)
    return fail(`liquidity $${Math.round(liquidity)} < $${liqFloor}`, checks, laneIn);
  checks.push("liquidity");
  const vol24 = snapshot.volume24hUsd ?? 0;
  const vol5 = snapshot.volume5mUsd;
  const vol1h = snapshot.volume1hUsd ?? 0;
  if (early) {
    if (vol5 == null || vol5 < limits.earlyMinVolume5mUsd) {
      return fail(
        `early 5m volume ${vol5 ?? "unknown"} < $${limits.earlyMinVolume5mUsd}`,
        checks,
        laneIn
      );
    }
  } else {
    const vol24Floor = laneIn === "pump" ? limits.pumpMinVolume24hUsd : limits.minVolume24hUsd;
    if (vol24 < vol24Floor)
      return fail(`24h volume $${Math.round(vol24)} < $${vol24Floor}`, checks, laneIn);
    if (vol1h < limits.minVolume1hUsd)
      return fail(`1h volume $${Math.round(vol1h)} < $${limits.minVolume1hUsd}`, checks, laneIn);
    if (vol5 == null || vol5 < limits.minVolume5mUsd) {
      return fail(`5m volume ${vol5 ?? "unknown"} < $${limits.minVolume5mUsd}`, checks, laneIn);
    }
  }
  checks.push("volume");
  const ratio = buySellRatio(snapshot.buys5m, snapshot.sells5m);
  if (ratio == null) return fail("buy pressure unknown", checks, laneIn);
  if (ratio < limits.minBuySellRatio5m) {
    return fail(`buy/sell ${ratio.toFixed(2)} < ${limits.minBuySellRatio5m}`, checks, laneIn);
  }
  checks.push("buy-pressure");
  const change5m = snapshot.change5mPct ?? 0;
  const change1h = snapshot.change1hPct ?? 0;
  if (change1h >= limits.max1hPumpPct)
    return fail(`1h pump ${change1h}% >= ${limits.max1hPumpPct}%`, checks, laneIn);
  checks.push("pump-cap");
  let lane = laneIn;
  const mults: Array<{ name: string; frac: number }> = [];
  if (change5m >= limits.max5mPumpPct) {
    if (!limits.surgeLaneEnabled)
      return fail(`5m pump ${change5m}% and surge lane off`, checks, laneIn);
    const pullback = snapshot.pullbackFromHighPct;
    const typical5m = vol1h > 0 ? vol1h / 12 : 0;
    const spikeOk = typical5m > 0 && (vol5 ?? 0) >= limits.surgeVolSpikeMult * typical5m;
    const pullOk =
      pullback != null &&
      pullback >= limits.surgePullbackMinPct &&
      pullback <= limits.surgePullbackMaxPct;
    if (!(pullOk && spikeOk && ratio >= limits.surgeMinBuySellRatio)) {
      return fail(`5m pump ${change5m}% without a surge pullback`, checks, laneIn);
    }
    lane = "surge";
    mults.push({ name: "surge", frac: limits.surgeSizeFrac });
    checks.push("surge");
  }
  const mcap = classifyMcap(
    snapshot.marketCapUsd ?? 0,
    { change5m, change1h, vol1h, vol24, early },
    limits
  );
  if (!mcap.ok) return fail(mcap.reason, checks, lane);
  if (mcap.sizeFrac > 0 && mcap.sizeFrac < 1) mults.push({ name: "mcap", frac: mcap.sizeFrac });
  checks.push("mcap");
  if (early && limits.earlyTicketFrac < 1)
    mults.push({ name: "early", frac: limits.earlyTicketFrac });
  const recency = scoreRecency(
    {
      pairCreatedAt: snapshot.pairCreatedAt,
      vol1h,
      vol6h: snapshot.volume6hUsd ?? 0,
      vol24,
      change5m,
      change1h,
      now,
    },
    limits
  );
  if (recency.reject) return fail(recency.reason, checks, lane);
  checks.push("recency");
  if (snapshot.signalAgeMs != null && snapshot.signalAgeMs > limits.earlyMaxLatencyMs && early) {
    return fail(
      `signal age ${snapshot.signalAgeMs}ms > ${limits.earlyMaxLatencyMs}ms`,
      checks,
      lane
    );
  }
  const holders = snapshot.holders ?? [];
  const creatorPct = snapshot.creator
    ? holders.find((holder) => (holder.address || holder.owner) === snapshot.creator)
    : undefined;
  const creatorHold = Number(creatorPct?.pct ?? creatorPct?.percentage ?? 0);
  const creatorHoldPct = creatorHold > 1.5 ? creatorHold / 100 : creatorHold;
  if (snapshot.creator && creatorHoldPct > limits.maxCreatorPct) {
    return fail(
      `creator holds ${(creatorHoldPct * 100).toFixed(1)}% > ${(limits.maxCreatorPct * 100).toFixed(0)}%`,
      checks,
      lane
    );
  }
  const dev = devHoldReject(snapshot.creator, holders);
  if (dev) return fail(dev, checks, lane);
  if (
    !snapshot.creator &&
    limits.manipFailClosed &&
    /pump$/i.test(snapshot.mint) &&
    snapshot.allowCreatorUnknown !== true
  ) {
    return fail("manip scan fail — creator unknown", checks, lane);
  }
  if (!snapshot.creator && snapshot.allowCreatorUnknown && lane === "x") {
    mults.push({ name: "creator-unknown", frac: limits.xCreatorUnknownFrac });
  }
  checks.push("creator");
  const rugReason = creatorRugReason(snapshot.mint, snapshot.rug ?? null, now, limits);
  if (rugReason) return fail(rugReason, checks, lane);
  checks.push("creator-rug");
  const actor = badActorHit(
    [
      snapshot.creator,
      ...holders.slice(0, 20).map((holder) => holder.address || holder.owner || null),
    ],
    snapshot.badActors ?? {}
  );
  if (actor) return fail(actor, checks, lane);
  checks.push("bad-actor");
  const top = top10ExLp(holders, limits);
  if (holders.length > 0 && top.over) {
    return fail(
      `top-10 holders ${(top.pct * 100).toFixed(0)}% > ${(limits.maxTop10Pct * 100).toFixed(0)}%`,
      checks,
      lane
    );
  }
  checks.push("top10");
  const bundlePct = rugRiskPct(snapshot.rug?.risks, "bundle");
  if (bundlePct > limits.bundleMaxPct) {
    return fail(`bundlers hold ${(bundlePct * 100).toFixed(0)}% > 15% (rugcheck)`, checks, lane);
  }
  const sniperPct = rugRiskPct(snapshot.rug?.risks, "sniper");
  if (sniperPct > limits.sniperMaxPct) {
    return fail(`snipers hold ${(sniperPct * 100).toFixed(0)}% > 15% (rugcheck)`, checks, lane);
  }
  if (snapshot.earlyTxs == null)
    return fail("manip scan fail — early transactions missing", checks, lane);
  const earlyScan = judgeEarlyBuyers({ txs: snapshot.earlyTxs, topHolders: holders }, limits);
  if (!earlyScan.ok) return fail(earlyScan.reason ?? "manip scan fail", checks, lane);
  checks.push("manip");
  const prebuy = judgePrebuy(snapshot.mint, snapshot.rug ?? null, snapshot.mr ?? null, limits);
  if (!prebuy.ok) return fail(prebuy.reason, checks, lane);
  checks.push(`prebuy:${prebuy.passedVia}`);
  const wr = walletWinRateReject(snapshot.walletWinRate, snapshot.walletClosedTrades, limits);
  if (wr) return fail(wr, checks, lane);
  checks.push("wallet");
  if (snapshot.cooldownUntil != null && now < snapshot.cooldownUntil) {
    return fail("rebuy cooldown", checks, lane);
  }
  if (snapshot.dayStartEquitySol != null && snapshot.equitySol != null) {
    if (dailyLossTripped(snapshot.equitySol, snapshot.dayStartEquitySol, limits)) {
      return fail("daily loss cap", checks, lane);
    }
  }
  if (bankFloorBlocks(snapshot.freeSol, snapshot.openCostSol ?? 0, limits)) {
    return fail("bank floor", checks, lane);
  }
  const equity = snapshot.equitySol ?? 0;
  const ticket = computeTicketSol(equity, 0, false, limits);
  const impactCap = lane === "pump" ? limits.apeMaxImpactPumpPct : limits.apeMaxImpactPct;
  const sized = chooseSize(
    {
      maxSol: Math.min(ticket, limits.ticketSolMax),
      minSol: limits.dynMinTicketSol,
      quoteSol: snapshot.quoteSol ?? 0.01,
      impactCap,
      buyImpactPct: snapshot.buyImpactPct,
      sellImpactPct: snapshot.sellImpactPct,
      rtCheck: (ticketSol, ctx) =>
        exceedsRoundTripCap(
          ticketSol,
          { buyImpactPct: ctx.buyImpactPct, sellImpactPct: snapshot.sellImpactPct },
          limits
        ),
    },
    limits
  );
  if (!(sized.size > 0)) return fail(sized.reason, checks, lane);
  const scaled = applyMultipliers(sized.size, mults, limits.dynMinTicketSol);
  if (!(scaled.size > 0)) return fail(scaled.skipped ?? "size below min", checks, lane);
  const costs = computeCosts(
    {
      ticketSol: scaled.size,
      buyImpactPct: snapshot.buyImpactPct,
      sellImpactPct: snapshot.sellImpactPct,
      liquidityUsd: liquidity,
      solUsd: snapshot.solUsd,
    },
    limits
  );
  const slip = shouldRejectForSlippage(
    {
      slPct:
        lane === "surge"
          ? limits.surgeSlPct
          : lane === "risk"
            ? limits.riskSlPct
            : lane === "main"
              ? limits.stopLossPct
              : limits.pumpSlPct,
      sellImpactPct: snapshot.sellImpactPct,
      buyImpactPct: snapshot.buyImpactPct,
      ticketSol: scaled.size,
      liquidityUsd: liquidity,
      solUsd: snapshot.solUsd,
    },
    limits
  );
  if (slip.reject) return fail(slip.reason ?? "slippage stop", checks, lane);
  const windowGate = windowNetGate(scaled.size, costs, limits);
  if (windowGate.reject) return fail(windowGate.reason ?? "window cost", checks, lane);
  checks.push("size");
  return { ok: true, reason: sized.reason, lane, sizeSol: scaled.size, checks };
}
