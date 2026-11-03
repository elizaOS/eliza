import { LIMITS, type Limits } from "./limits.ts";

export function prioritySolForTicket(ticketSol: number, limits: Limits = LIMITS): number {
  const ticket = Number(ticketSol) || 0;
  if (ticket > 0 && ticket <= 0.015) return limits.priorityFeeSolSmall;
  return limits.priorityFeeSol;
}

export function tipSolForTicket(ticketSol: number, limits: Limits = LIMITS): number {
  const ticket = Number(ticketSol) || 0;
  const small = ticket > 0 && ticket <= 0.015;
  const lo = small ? limits.jitoTipLamportsMinSmall : limits.jitoTipLamportsMin;
  const hi = small ? limits.jitoTipLamportsMaxSmall : limits.jitoTipLamportsMax;
  return (lo + hi) / 2 / 1e9;
}

export interface RoundTripEstimate {
  totalSol: number;
  pct: number;
  feeRt: number;
  ataPad: number;
  slipCost: number;
  frictionPct: number;
  prioritySol: number;
  tipSol: number;
}

/** Expected round-trip cost. Impact is quoted impact, not the max slippage setting. */
export function estimateRoundTrip(
  input: {
    ticketSol: number;
    buyImpactPct?: number | null;
    sellImpactPct?: number | null;
    newAta?: boolean;
  },
  limits: Limits = LIMITS
): RoundTripEstimate {
  const ticket = Math.max(1e-9, Number(input.ticketSol) || 0);
  const prioritySol = prioritySolForTicket(ticket, limits);
  const tipSol = tipSolForTicket(ticket, limits);
  const base = 0.000005;
  const feeRt = 2 * (prioritySol + tipSol + base);
  const ata = input.newAta === false ? 0 : limits.ataRentUnrecoveredPadSol;
  const buyImpact = Math.max(0, Number(input.buyImpactPct) || 0);
  const sellImpact = Math.max(0, Number(input.sellImpactPct) || 0);
  const quotedImpact = buyImpact + sellImpact;
  const frictionPct = quotedImpact > 0 ? quotedImpact : limits.rtDefaultFrictionPct;
  const slipCost = ticket * frictionPct;
  const totalSol = feeRt + ata + slipCost;
  return {
    totalSol,
    pct: totalSol / ticket,
    feeRt,
    ataPad: ata,
    slipCost,
    frictionPct,
    prioritySol,
    tipSol,
  };
}

export function exceedsRoundTripCap(
  ticketSol: number,
  opts: { buyImpactPct?: number | null; sellImpactPct?: number | null; newAta?: boolean } = {},
  limits: Limits = LIMITS
): { blocked: boolean; maxPct: number } & RoundTripEstimate {
  const est = estimateRoundTrip({ ticketSol, ...opts }, limits);
  return {
    blocked: est.pct > limits.maxRoundTripCostPct + 1e-12,
    maxPct: limits.maxRoundTripCostPct,
    ...est,
  };
}
