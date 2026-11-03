import { type Lane, LIMITS, type Limits } from "./limits.ts";

export function tradeableSol(
  freeSol: number,
  reserveSol: number,
  netSol: number,
  limits: Limits = LIMITS
): number {
  return Math.max(0, freeSol - reserveSol - netSol - limits.feeReserveSol);
}

export function computeTicketSol(
  equitySol: number,
  pendingReinvestSol = 0,
  halfTickets = false,
  limits: Limits = LIMITS
): number {
  const equity = Math.max(0, Number(equitySol) || 0);
  const feeFloor =
    limits.maxFeeDragPct > 0
      ? limits.feeEstOneWaySol / limits.maxFeeDragPct
      : limits.ticketSolFloor;
  let ticket = Math.max(limits.ticketSolFloor, equity * limits.ticketEquityPct, feeFloor);
  if (equity >= limits.principalSol && pendingReinvestSol > 0) {
    ticket += pendingReinvestSol / Math.max(1, limits.compoundSplitBuys);
  }
  if (ticket > limits.ticketSolMax) ticket = limits.ticketSolMax;
  if (halfTickets) ticket = Math.max(limits.ticketSolFloor, ticket * 0.5);
  return Math.floor(ticket * 1e9) / 1e9;
}

export interface SlotPlan {
  ticketSol: number;
  spendableSol: number;
  maxOpenSlots: number;
  laneSlots: Record<Lane, number>;
}

export function recomputeSlots(
  input: {
    equitySol: number;
    freeSol: number;
    reserveSol?: number;
    netSol?: number;
    pendingReinvestSol?: number;
    halfTickets?: boolean;
    openPositions?: number;
  },
  limits: Limits = LIMITS
): SlotPlan {
  const equity = Math.max(0, input.equitySol);
  const free = Math.max(0, input.freeSol);
  const spendable = tradeableSol(free, input.reserveSol ?? 0, input.netSol ?? 0, limits);
  const ticket = computeTicketSol(
    equity,
    input.pendingReinvestSol ?? 0,
    input.halfTickets === true,
    limits
  );
  const funded = ticket > 0 ? Math.floor(spendable / ticket) : 0;
  const byEquity = ticket > 0 ? Math.floor(equity / ticket) : 0;
  const open = input.openPositions ?? 0;
  const slots = Math.min(
    limits.maxOpenPositionsCap,
    Math.max(limits.minOpenPositions, Math.max(funded, Math.min(byEquity, funded + open)))
  );
  const maxOpenSlots = Math.max(1, slots);
  const laneFloor = (frac: number) => Math.max(frac > 0 ? 1 : 0, Math.floor(maxOpenSlots * frac));
  const riskBudget = Math.max(1, Math.floor(maxOpenSlots * limits.riskLaneSlotFrac));
  const laneSlots: Record<Lane, number> = {
    main: maxOpenSlots,
    pump: laneFloor(limits.pumpLaneSlotFrac),
    x: laneFloor(limits.xLaneSlotFrac),
    grad: laneFloor(limits.gradLaneSlotFrac),
    mr: laneFloor(limits.mrLaneSlotFrac),
    jup: laneFloor(limits.jupLaneSlotFrac),
    wave: laneFloor(limits.waveLaneSlotFrac),
    risk: Math.min(limits.riskMaxConcurrent, Math.max(2, riskBudget)),
    surge: maxOpenSlots,
  };
  return { ticketSol: ticket, spendableSol: spendable, maxOpenSlots, laneSlots };
}

export interface WaveSplit {
  reinvest: number;
  reserve: number;
  net: number;
  mode: "flat" | "below_principal" | "at_principal";
}

/** Winning-wave split stays in the same wallet. A losing wave banks nothing. */
export function splitWaveProfit(
  wavePnlSol: number,
  equitySol: number,
  limits: Limits = LIMITS
): WaveSplit {
  if (!(wavePnlSol > 0)) return { reinvest: 0, reserve: 0, net: 0, mode: "flat" };
  if (equitySol < limits.principalSol) {
    return {
      reinvest: wavePnlSol * limits.compoundBelowReinvestFrac,
      reserve: wavePnlSol * limits.compoundBelowReserveFrac,
      net: wavePnlSol * limits.compoundBelowNetFrac,
      mode: "below_principal",
    };
  }
  return {
    reinvest: wavePnlSol * limits.compoundReinvestFrac,
    reserve: wavePnlSol * limits.compoundReserveFrac,
    net: wavePnlSol * limits.compoundNetFrac,
    mode: "at_principal",
  };
}
