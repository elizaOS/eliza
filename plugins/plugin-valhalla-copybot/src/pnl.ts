import { LIMITS } from "./limits.ts";

export interface ClosedLeg {
  mint: string;
  lane: string;
  costSol: number;
  exitSol: number;
  solUsd: number;
  closedAt: number;
  reason: string;
}

export function realizedFromExit(
  exitSol: number,
  costSol: number,
  solUsd: number
): {
  exitSol: number;
  pnlSol: number;
  pnlUsd: number;
  pnlPct: number;
} {
  const cost = Number(costSol) || 0;
  const exit = Number(exitSol) || 0;
  const pnlSol = exit - cost;
  const price = Number(solUsd) || LIMITS.solUsdFallback;
  return { exitSol: exit, pnlSol, pnlUsd: pnlSol * price, pnlPct: cost > 0 ? pnlSol / cost : 0 };
}

export interface PnlReport {
  trades: number;
  wins: number;
  losses: number;
  pnlSol: number;
  pnlUsd: number;
  byLane: Record<string, { trades: number; pnlSol: number }>;
}

export function summarizePnl(legs: ClosedLeg[]): PnlReport {
  const byLane: PnlReport["byLane"] = {};
  let pnlSol = 0;
  let pnlUsd = 0;
  let wins = 0;
  let losses = 0;
  for (const leg of legs) {
    const row = realizedFromExit(leg.exitSol, leg.costSol, leg.solUsd);
    pnlSol += row.pnlSol;
    pnlUsd += row.pnlUsd;
    if (row.pnlSol > 0) wins += 1;
    else if (row.pnlSol < 0) losses += 1;
    const lane = byLane[leg.lane] ?? { trades: 0, pnlSol: 0 };
    lane.trades += 1;
    lane.pnlSol += row.pnlSol;
    byLane[leg.lane] = lane;
  }
  return { trades: legs.length, wins, losses, pnlSol, pnlUsd, byLane };
}
