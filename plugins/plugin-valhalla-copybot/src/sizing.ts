import { LIMITS, type Limits } from "./limits.ts";

export interface SizeChoice {
  size: number;
  reason: string;
  tried: string[];
}

export function chooseSize(
  input: {
    maxSol: number;
    minSol?: number;
    quoteSol?: number;
    impactCap?: number;
    buyImpactPct?: number | null;
    sellImpactPct?: number | null;
    steps?: readonly number[];
    rtCheck?: (
      ticketSol: number,
      ctx: { buyImpactPct: number }
    ) => { blocked: boolean; pct: number };
  },
  limits: Limits = LIMITS
): SizeChoice {
  const maxSol = Number(input.maxSol) || 0;
  const minSol = input.minSol != null ? Number(input.minSol) : limits.dynMinTicketSol;
  const quoteSol = Number(input.quoteSol) > 0 ? Number(input.quoteSol) : 0.01;
  const cap = Number(input.impactCap) > 0 ? Number(input.impactCap) : limits.apeMaxImpactPct;
  const buyImpact =
    input.buyImpactPct != null && Number.isFinite(Number(input.buyImpactPct))
      ? Math.max(0, Number(input.buyImpactPct))
      : null;
  const sellImpact =
    input.sellImpactPct != null && Number.isFinite(Number(input.sellImpactPct))
      ? Math.max(0, Number(input.sellImpactPct))
      : null;
  const steps = (input.steps ?? limits.dynSizeSteps).filter(
    (step) => step <= maxSol + 1e-12 && step >= minSol - 1e-12
  );
  if (maxSol > 0 && !steps.some((step) => Math.abs(step - maxSol) < 1e-12) && maxSol >= minSol) {
    steps.unshift(maxSol);
  }
  steps.sort((a, b) => b - a);
  const rtCheck = input.rtCheck;
  const tried: string[] = [];
  for (const size of steps) {
    const scale = size / quoteSol;
    const buyEst = buyImpact == null ? null : buyImpact * scale;
    const sellEst = sellImpact == null ? null : sellImpact * scale;
    if (buyEst != null && buyEst > cap) {
      tried.push(`${size}:buyImp ${(buyEst * 100).toFixed(1)}%`);
      continue;
    }
    if (sellEst != null && sellEst > cap) {
      tried.push(`${size}:sellImp ${(sellEst * 100).toFixed(1)}%`);
      continue;
    }
    if (rtCheck) {
      const rt = rtCheck(size, { buyImpactPct: buyEst ?? 0 });
      if (rt.blocked) {
        tried.push(`${size}:rt ${(rt.pct * 100).toFixed(1)}%`);
        continue;
      }
    }
    const why =
      buyImpact == null && sellImpact == null
        ? "no quoted impact; RT ok"
        : `buyImp~${((buyEst ?? 0) * 100).toFixed(1)}% sellImp~${((sellEst ?? 0) * 100).toFixed(1)}% <= ${(cap * 100).toFixed(0)}%`;
    return {
      size,
      reason: (size < maxSol ? `stepped down from ${maxSol}: ` : "") + why,
      tried,
    };
  }
  return {
    size: 0,
    reason: `no step >= ${minSol} passes impact/RT (${tried.join(", ") || "max<min"})`,
    tried,
  };
}

export function applyMultipliers(
  size: number,
  mults: Array<{ name: string; frac: number }>,
  minSol: number = LIMITS.dynMinTicketSol
): { size: number; applied: string[]; skipped: string | null } {
  let next = size;
  const applied: string[] = [];
  for (const mult of mults) {
    const frac = Number(mult.frac);
    if (next > 0 && Number.isFinite(frac) && frac > 0 && frac < 1) {
      next = Math.floor(next * frac * 1e9) / 1e9;
      applied.push(`${mult.name}x${frac}`);
    }
  }
  if (next > 0 && next < minSol - 1e-12) {
    return {
      size: 0,
      applied,
      skipped: `after ${applied.join(",")} ${next.toFixed(4)} < min ${minSol}`,
    };
  }
  return { size: next, applied, skipped: null };
}
