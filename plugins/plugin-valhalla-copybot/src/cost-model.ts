import { estimateRoundTrip } from "./fees.ts";
import { LIMITS, type Limits } from "./limits.ts";

function finiteOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

export interface CostBreakdown {
  ticketSol: number;
  feeEstSol: number;
  feeSol: number;
  feePct: number;
  buyImpQ: number | null;
  sellImpQ: number | null;
  quotedImpactPct: number;
  slipPct: number;
  allInRtPct: number;
  sellLegPct: number;
  sellLegVia: "quote" | "liq_proxy" | "pad_half";
  exitFeePct: number;
  legacyRtPct: number;
}

export function computeCosts(
  input: {
    ticketSol: number;
    buyImpactPct?: number | null;
    sellImpactPct?: number | null;
    liquidityUsd?: number | null;
    solUsd?: number | null;
    newAta?: boolean;
  },
  limits: Limits = LIMITS
): CostBreakdown {
  const ticket = Math.max(1e-9, Number(input.ticketSol) || 0);
  const est = estimateRoundTrip({ ticketSol: ticket, newAta: input.newAta !== false }, limits);
  const feeEstSol = est.feeRt + est.ataPad;
  const feeSol = Math.max(feeEstSol, limits.costFeeFloorSol);
  const feePct = feeSol / ticket;
  const buyRaw = finiteOrNull(input.buyImpactPct);
  const sellRaw = finiteOrNull(input.sellImpactPct);
  const buyImpQ = buyRaw == null ? null : Math.max(0, buyRaw);
  const sellImpQ = sellRaw == null ? null : Math.max(0, sellRaw);
  const quotedImpactPct = (buyImpQ ?? 0) + (sellImpQ ?? 0);
  const slipPct = Math.max(quotedImpactPct, limits.costSlipPadPct);
  let sellLegPct: number;
  let sellLegVia: CostBreakdown["sellLegVia"];
  if (sellImpQ != null) {
    sellLegPct = sellImpQ;
    sellLegVia = "quote";
  } else {
    const liquidity = finiteOrNull(input.liquidityUsd) ?? 0;
    const solUsd = finiteOrNull(input.solUsd) ?? limits.solUsdFallback;
    if (liquidity > 0) {
      sellLegPct = Math.min(0.25, (ticket * solUsd) / liquidity);
      sellLegVia = "liq_proxy";
    } else {
      sellLegPct = limits.costSlipPadPct / 2;
      sellLegVia = "pad_half";
    }
  }
  const exitFeePct = (est.prioritySol + est.tipSol + 0.000005) / ticket;
  const legacyFriction = quotedImpactPct > 0 ? quotedImpactPct : limits.rtDefaultFrictionPct;
  return {
    ticketSol: ticket,
    feeEstSol,
    feeSol,
    feePct,
    buyImpQ,
    sellImpQ,
    quotedImpactPct,
    slipPct,
    allInRtPct: feePct + slipPct,
    sellLegPct,
    sellLegVia,
    exitFeePct,
    legacyRtPct: (feeEstSol + ticket * legacyFriction) / ticket,
  };
}
