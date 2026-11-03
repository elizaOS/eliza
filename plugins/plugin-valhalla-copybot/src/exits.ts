import { pairAgeMs } from "./filters.ts";
import { type Lane, LIMITS, type Limits } from "./limits.ts";

export interface PositionView {
  id: string;
  mint: string;
  lane: Lane;
  status: "OPEN" | "CLOSED";
  costSol: number;
  originalCostSol: number;
  entryPriceUsd: number;
  markPriceUsd: number;
  markAt: number;
  openedAt: number;
  tpNet10Taken: boolean;
  tpNet10Armed: boolean;
  peakPriceUsd: number;
  trailArmed: boolean;
  transferTaxBps: number;
  pairCreatedAt?: number | string | null;
  entryMcapUsd?: number | null;
  hold: boolean;
  riskTp1Taken: boolean;
  riskTp2Taken: boolean;
}

export interface ExitDecision {
  action: "hold" | "partial" | "close";
  label: string;
  reason: string;
  fraction: number;
}

export interface TpNetLaneConfig {
  threshold: number;
  partialFrac: number;
  floor: number;
  timeStopMin: number | null;
  timeStopMaxPnl: number | null;
  suppressLaneTp: boolean;
  poolFeePct: number;
  sellImpactPct: number;
  dustMinSol: number;
  dustMaxFeePct: number;
}

export function tpNetConfig(lane: Lane, limits: Limits = LIMITS): TpNetLaneConfig {
  const base: TpNetLaneConfig = {
    threshold: limits.userTpThreshold ?? 0.1,
    partialFrac: limits.userTpPartial ?? 0.75,
    floor: limits.userTpFloor ?? 0.03,
    timeStopMin: null,
    timeStopMaxPnl: 0.03,
    suppressLaneTp: false,
    poolFeePct: limits.tpNetPoolFeePct,
    sellImpactPct: limits.tpNetSellImpactPct,
    dustMinSol: limits.tpNetDustMinSol,
    dustMaxFeePct: limits.tpNetDustMaxFeePct,
  };
  if (lane === "main") {
    return {
      ...base,
      threshold: limits.userTpThreshold ?? 0.15,
      partialFrac: limits.userTpPartial ?? 0.75,
      floor: limits.userTpFloor ?? 0.03,
      timeStopMin: 5,
      timeStopMaxPnl: 0.03,
      suppressLaneTp: true,
    };
  }
  if (!(base.floor < base.threshold)) {
    base.floor = Math.min(base.floor, base.threshold / 2);
  }
  return base;
}

export function laneStopPct(lane: Lane, limits: Limits = LIMITS): number {
  if (lane === "risk") return limits.riskSlPct;
  if (lane === "surge") return limits.surgeSlPct;
  if (lane === "main") return limits.stopLossPct;
  return limits.pumpSlPct;
}

export function laneMaxHoldMs(lane: Lane, limits: Limits = LIMITS): number {
  if (lane === "x") return limits.xMaxHoldMs;
  if (lane === "risk") return limits.riskMaxHoldMs;
  if (lane === "wave") return limits.waveMaxHoldMs;
  if (lane === "pump") return limits.pumpMaxHoldMs;
  if (lane === "grad") return limits.gradMaxHoldMs;
  if (lane === "mr") return limits.mrMaxHoldMs;
  if (lane === "jup") return limits.jupMaxHoldMs;
  return limits.maxHoldMs;
}

export function laneTrailPct(lane: Lane, limits: Limits = LIMITS): number {
  if (lane === "main") return limits.mainTrailPct;
  if (lane === "surge") return limits.surgeTrailPct;
  if (lane === "risk") return limits.riskTrailPct;
  return limits.trailPct;
}

export function legFeeSol(limits: Limits = LIMITS): number {
  return Math.max(limits.priorityFeeSol, 0.0001) + 0.000005;
}

export function solIn(
  pos: Pick<PositionView, "costSol" | "originalCostSol">,
  limits: Limits = LIMITS
): number {
  const cost = Number(pos.costSol) || 0;
  const orig = Number(pos.originalCostSol) || cost;
  const share = orig > 0 ? Math.min(1, cost / orig) : 1;
  return cost + legFeeSol(limits) * share;
}

function sellTax(pos: Pick<PositionView, "transferTaxBps">): number {
  const bps = Number(pos.transferTaxBps) || 0;
  return bps > 0 ? Math.min(0.5, bps / 10_000) : 0;
}

export function netFromOutSol(
  pos: Pick<PositionView, "costSol" | "originalCostSol" | "transferTaxBps">,
  outSol: number,
  limits: Limits = LIMITS
): number | null {
  const input = solIn(pos, limits);
  if (!(input > 0) || !(outSol > 0)) return null;
  return (outSol * (1 - sellTax(pos)) - legFeeSol(limits)) / input - 1;
}

export function markOutSol(
  pos: Pick<PositionView, "costSol" | "entryPriceUsd" | "lane">,
  priceUsd: number,
  limits: Limits = LIMITS
): number | null {
  if (!(priceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;
  const cfg = tpNetConfig(pos.lane, limits);
  const gross = pos.costSol * (priceUsd / pos.entryPriceUsd);
  return gross * Math.max(0.5, 1 - cfg.poolFeePct - cfg.sellImpactPct);
}

export function netFromMark(
  pos: Pick<
    PositionView,
    "costSol" | "originalCostSol" | "entryPriceUsd" | "transferTaxBps" | "lane"
  >,
  priceUsd: number,
  limits: Limits = LIMITS
): number | null {
  const out = markOutSol(pos, priceUsd, limits);
  return out == null ? null : netFromOutSol(pos, out, limits);
}

export function partialFraction(
  pos: Pick<PositionView, "costSol" | "originalCostSol" | "lane">,
  outSolFull: number,
  limits: Limits = LIMITS
): { frac: number; dust: boolean } {
  const cfg = tpNetConfig(pos.lane, limits);
  if (cfg.partialFrac >= 0.999) return { frac: 1, dust: false };
  const remSol = (outSolFull || 0) * (1 - cfg.partialFrac);
  const fee = legFeeSol(limits);
  if (remSol < cfg.dustMinSol) return { frac: 1, dust: true };
  if (fee > cfg.dustMaxFeePct * remSol) return { frac: 1, dust: true };
  return { frac: cfg.partialFrac, dust: false };
}

export interface AdaptiveTier {
  tier: "fresh" | "mid" | "mature";
  windowMs: number;
  tpPct: number;
  slPct: number;
  repairMinPct: number;
}

export function adaptiveTier(ageMs: number | null, mcap: number): AdaptiveTier {
  const young = ageMs != null && ageMs < 60 * 60 * 1000;
  const midAge = ageMs != null && ageMs >= 60 * 60 * 1000 && ageMs < 24 * 60 * 60 * 1000;
  const oldAge = ageMs != null && ageMs >= 24 * 60 * 60 * 1000;
  const small = mcap > 0 && mcap < 150_000;
  const midMc = mcap >= 150_000 && mcap <= 1_000_000;
  const bigMc = mcap > 1_000_000;
  if (young || small) {
    return {
      tier: "fresh",
      windowMs: 6 * 60 * 1000,
      tpPct: 0.18,
      slPct: -0.07,
      repairMinPct: 0.03,
    };
  }
  if (midAge || midMc || (!oldAge && !bigMc)) {
    return { tier: "mid", windowMs: 12 * 60 * 1000, tpPct: 0.14, slPct: -0.08, repairMinPct: 0.03 };
  }
  return { tier: "mature", windowMs: 20 * 60 * 1000, tpPct: 0.1, slPct: -0.08, repairMinPct: 0.03 };
}

function hold(reason = "hold"): ExitDecision {
  return { action: "hold", label: "hold", reason, fraction: 0 };
}

function close(label: string, reason: string, fraction = 1): ExitDecision {
  return { action: fraction < 0.999 ? "partial" : "close", label, reason, fraction };
}

export function quoteAwareStopHit(input: {
  markPnlPct: number | null;
  stopPct: number;
  markPriceUsd: number;
  stopPriceUsd: number;
  quoteNetPct: number | null;
  quoteOk: boolean;
}): { hit: boolean; via: "quote" | "mark" | null } {
  const markHit =
    (input.stopPriceUsd > 0 &&
      input.markPriceUsd > 0 &&
      input.markPriceUsd <= input.stopPriceUsd) ||
    (input.markPnlPct != null && input.markPnlPct <= input.stopPct);
  if (input.quoteOk && input.quoteNetPct != null && input.quoteNetPct <= input.stopPct) {
    return { hit: true, via: "quote" };
  }
  if (markHit) return { hit: true, via: "mark" };
  return { hit: false, via: null };
}

/**
 * Exit order matches the bot: hard stop first, then time and stale exits,
 * then quote-confirmed net take-profit. A mark above the target does not sell
 * until a sell quote confirms it.
 */
export function decideExit(
  pos: PositionView,
  input: {
    now?: number;
    sessionStartedAt?: number;
    quoteOutSol?: number | null;
    quoteOk?: boolean;
  } = {},
  limits: Limits = LIMITS
): ExitDecision {
  if (pos.hold || pos.status === "CLOSED") return hold("not open");
  const now = input.now ?? Date.now();
  const cfg = tpNetConfig(pos.lane, limits);
  const markPnl =
    pos.entryPriceUsd > 0 && pos.markPriceUsd > 0 ? pos.markPriceUsd / pos.entryPriceUsd - 1 : null;
  const markNet = pos.markPriceUsd > 0 ? netFromMark(pos, pos.markPriceUsd, limits) : null;
  const quoteOk = input.quoteOk === true && (input.quoteOutSol ?? 0) > 0;
  const quoteNet =
    quoteOk && input.quoteOutSol != null ? netFromOutSol(pos, input.quoteOutSol, limits) : null;
  const stopPct = laneStopPct(pos.lane, limits);
  const stopPrice = pos.entryPriceUsd > 0 ? pos.entryPriceUsd * (1 + stopPct) : 0;
  const stop = quoteAwareStopHit({
    markPnlPct: markPnl,
    stopPct,
    markPriceUsd: pos.markPriceUsd,
    stopPriceUsd: stopPrice,
    quoteNetPct: quoteNet,
    quoteOk,
  });
  if (stop.hit) {
    return close("hard_stop", `hard stop ${stopPct} via ${stop.via}`);
  }
  const age = now - pos.openedAt;
  if (pos.lane === "risk" && age >= limits.riskMaxHoldMs) {
    if (!((markPnl ?? -1) > limits.riskHoldOverridePnl && pos.trailArmed)) {
      return close("max_hold", `risk max hold ${limits.riskMaxHoldMs}ms`);
    }
  } else if (pos.lane !== "risk" && age >= laneMaxHoldMs(pos.lane, limits)) {
    return close("max_hold", `max hold ${laneMaxHoldMs(pos.lane, limits)}ms`);
  }
  if (age >= limits.staleExitMs && (markPnl ?? -1) <= limits.staleExitMinPnl) {
    return close("stale", `stale ${limits.staleExitMs}ms pnl <= ${limits.staleExitMinPnl}`);
  }
  const tier = adaptiveTier(pairAgeMs(pos.pairCreatedAt, now), Number(pos.entryMcapUsd ?? 0));
  if (age >= tier.windowMs && (markPnl ?? -1) < tier.repairMinPct) {
    return close("repair", `repair window ${tier.tier} pnl < ${tier.repairMinPct}`);
  }
  const sessionStarted = input.sessionStartedAt ?? pos.openedAt;
  const aged = now - Math.max(pos.openedAt, sessionStarted);
  const netForTime = quoteNet ?? markNet;
  if (
    cfg.timeStopMin != null &&
    !pos.tpNet10Taken &&
    !pos.tpNet10Armed &&
    aged >= cfg.timeStopMin * 60_000 &&
    netForTime != null &&
    (cfg.timeStopMaxPnl == null || netForTime < cfg.timeStopMaxPnl)
  ) {
    return close("time_stop", `time stop ${cfg.timeStopMin}m net < ${cfg.timeStopMaxPnl}`);
  }
  if (pos.tpNet10Armed) {
    const floorView = {
      ...pos,
      costSol: pos.originalCostSol || pos.costSol,
      originalCostSol: pos.originalCostSol || pos.costSol,
    };
    const floorMark = netFromMark(floorView, pos.markPriceUsd, limits);
    const floorQuote =
      quoteOk && input.quoteOutSol != null
        ? netFromOutSol(
            floorView,
            input.quoteOutSol *
              ((pos.originalCostSol || pos.costSol) / Math.max(pos.costSol, 1e-12)),
            limits
          )
        : null;
    if (
      (floorMark != null && floorMark <= cfg.floor) ||
      (floorQuote != null && floorQuote <= cfg.floor)
    ) {
      return close("tp_floor", `tp floor ${cfg.floor} net`);
    }
    if (
      pos.peakPriceUsd > 0 &&
      pos.markPriceUsd <= pos.peakPriceUsd * (1 - laneTrailPct(pos.lane, limits))
    ) {
      return close("trail", `trail ${laneTrailPct(pos.lane, limits)} from peak`);
    }
    return hold("armed remainder");
  }
  if (
    !pos.tpNet10Taken &&
    quoteNet != null &&
    quoteNet >= cfg.threshold - 1e-12 &&
    input.quoteOutSol != null
  ) {
    const part = partialFraction(pos, input.quoteOutSol, limits);
    return close(
      part.frac >= 0.999 ? "tp_net_full" : "tp_net_partial",
      `net ${(quoteNet * 100).toFixed(2)}% >= ${(cfg.threshold * 100).toFixed(0)}%`,
      part.frac
    );
  }
  if (cfg.suppressLaneTp)
    return hold(quoteNet == null ? "tp needs a sell quote" : "below net target");
  if (pos.lane === "risk") {
    if (!pos.riskTp1Taken && (markPnl ?? -1) >= limits.riskTp1Pct && quoteOk) {
      return close("risk_tp1", `risk +${limits.riskTp1Pct * 100}%`, limits.riskTp1Frac);
    }
    if (pos.riskTp1Taken && !pos.riskTp2Taken && (markPnl ?? -1) >= limits.riskTp2Pct && quoteOk) {
      return close("risk_tp2", `risk +${limits.riskTp2Pct * 100}%`, limits.riskTp2FracOfOriginal);
    }
  } else if (pos.lane === "surge") {
    if ((markPnl ?? -1) >= limits.surgeTpPct && quoteOk) {
      return close("surge_tp", `surge +${limits.surgeTpPct * 100}%`, limits.surgeTpPartialFrac);
    }
  } else if ((markPnl ?? -1) >= tier.tpPct && quoteOk) {
    return close("lane_tp", `${pos.lane} tp ${tier.tpPct}`, 0.5);
  }
  if (pos.trailArmed && pos.peakPriceUsd > 0 && pos.markPriceUsd > 0) {
    const trail = laneTrailPct(pos.lane, limits);
    if (pos.markPriceUsd <= pos.peakPriceUsd * (1 - trail)) {
      return close("trail", `trail ${trail} from peak`);
    }
  }
  return hold("no exit");
}
