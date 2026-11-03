import { type CoinSnapshot, type Evaluation, evaluateCoin } from "./evaluate.ts";
import { decideExit, type ExitDecision, markOutSol, type PositionView } from "./exits.ts";
import { type Lane, LIMITS, type Limits } from "./limits.ts";
import { type ClosedLeg, realizedFromExit, summarizePnl } from "./pnl.ts";
import { recomputeSlots, splitWaveProfit } from "./slots.ts";

export interface OpenPosition extends PositionView {
  symbol: string;
  sizeSol: number;
  rawAmount: string;
  signature: string | null;
  paper: boolean;
}

export interface BookState {
  equitySol: number;
  freeSol: number;
  reserveSol: number;
  netSol: number;
  pendingReinvestSol: number;
  solUsd: number;
  dayStartEquitySol: number;
  positions: OpenPosition[];
  closed: ClosedLeg[];
  cooldowns: Record<string, number>;
  wavePnlSol: number;
  running: boolean;
  sessionStartedAt: number;
}

export function createBook(
  input: { equitySol?: number; solUsd?: number; now?: number } = {}
): BookState {
  const equity = input.equitySol ?? 0.27;
  return {
    equitySol: equity,
    freeSol: equity,
    reserveSol: 0,
    netSol: 0,
    pendingReinvestSol: 0,
    solUsd: input.solUsd ?? LIMITS.solUsdFallback,
    dayStartEquitySol: equity,
    positions: [],
    closed: [],
    cooldowns: {},
    wavePnlSol: 0,
    running: false,
    sessionStartedAt: input.now ?? Date.now(),
  };
}

function openCost(book: BookState): number {
  return book.positions.reduce((sum, pos) => sum + pos.costSol, 0);
}

export function statusText(book: BookState, live: boolean, limits: Limits = LIMITS): string {
  const slots = recomputeSlots(
    {
      equitySol: book.equitySol,
      freeSol: book.freeSol,
      reserveSol: book.reserveSol,
      netSol: book.netSol,
      pendingReinvestSol: book.pendingReinvestSol,
      openPositions: book.positions.length,
    },
    limits
  );
  const pnl = summarizePnl(book.closed);
  const lines = [
    `mode=${live ? "live" : "paper"} running=${book.running}`,
    `equity=${book.equitySol.toFixed(4)} SOL free=${book.freeSol.toFixed(4)} reserve=${book.reserveSol.toFixed(4)} net=${book.netSol.toFixed(4)}`,
    `slots=${book.positions.length}/${slots.maxOpenSlots} ticket=${slots.ticketSol}`,
    `closed=${pnl.trades} pnl=${pnl.pnlSol.toFixed(4)} SOL (${pnl.pnlUsd.toFixed(2)} USD)`,
  ];
  for (const pos of book.positions) {
    lines.push(
      `open ${pos.symbol} ${pos.mint.slice(0, 6)}… lane=${pos.lane} cost=${pos.costSol} mark=${pos.markPriceUsd} paper=${pos.paper}`
    );
  }
  return lines.join("\n");
}

export interface EntryResult {
  ok: boolean;
  reason: string;
  evaluation: Evaluation;
  position: OpenPosition | null;
}

export function considerEntry(
  book: BookState,
  snapshot: CoinSnapshot,
  limits: Limits = LIMITS
): { evaluation: Evaluation; slotsLeft: boolean } {
  const slots = recomputeSlots(
    {
      equitySol: book.equitySol,
      freeSol: book.freeSol,
      reserveSol: book.reserveSol,
      netSol: book.netSol,
      pendingReinvestSol: book.pendingReinvestSol,
      openPositions: book.positions.length,
    },
    limits
  );
  const lane: Lane = snapshot.lane ?? "main";
  const used = book.positions.filter((pos) => pos.lane === lane || lane === "main").length;
  const cap = lane === "main" ? slots.maxOpenSlots : slots.laneSlots[lane];
  const evaluation = evaluateCoin(
    {
      ...snapshot,
      equitySol: book.equitySol,
      freeSol: book.freeSol,
      openCostSol: openCost(book),
      dayStartEquitySol: book.dayStartEquitySol,
      cooldownUntil: book.cooldowns[snapshot.mint] ?? null,
      alreadyHeld: book.positions.some((pos) => pos.mint === snapshot.mint),
      solUsd: snapshot.solUsd ?? book.solUsd,
      now: snapshot.now ?? Date.now(),
    },
    limits
  );
  return { evaluation, slotsLeft: used < cap };
}

export function openPaper(
  book: BookState,
  snapshot: CoinSnapshot,
  evaluation: Evaluation,
  now = Date.now()
): OpenPosition {
  const entry = snapshot.marketCapUsd && snapshot.marketCapUsd > 0 ? snapshot.marketCapUsd : 1;
  const position: OpenPosition = {
    id: `${snapshot.mint}:${now}`,
    mint: snapshot.mint,
    symbol: snapshot.symbol || snapshot.mint.slice(0, 6),
    lane: evaluation.lane,
    status: "OPEN",
    costSol: evaluation.sizeSol,
    originalCostSol: evaluation.sizeSol,
    sizeSol: evaluation.sizeSol,
    entryPriceUsd: entry,
    markPriceUsd: entry,
    markAt: now,
    openedAt: now,
    tpNet10Taken: false,
    tpNet10Armed: false,
    peakPriceUsd: entry,
    trailArmed: false,
    transferTaxBps: 0,
    pairCreatedAt: snapshot.pairCreatedAt ?? null,
    entryMcapUsd: snapshot.marketCapUsd ?? null,
    hold: false,
    riskTp1Taken: false,
    riskTp2Taken: false,
    rawAmount: "0",
    signature: null,
    paper: true,
  };
  book.positions.push(position);
  book.freeSol = Math.max(0, book.freeSol - evaluation.sizeSol);
  return position;
}

export interface MarkUpdate {
  mint: string;
  priceUsd: number;
  quoteOutSol?: number | null;
  quoteOk?: boolean;
}

export function applyMarks(
  book: BookState,
  marks: MarkUpdate[],
  now = Date.now(),
  limits: Limits = LIMITS
): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  const markByMint = new Map(marks.map((mark) => [mark.mint, mark]));
  const stillOpen: OpenPosition[] = [];
  for (const pos of book.positions) {
    const mark = markByMint.get(pos.mint);
    if (mark && mark.priceUsd > 0) {
      pos.markPriceUsd = mark.priceUsd;
      pos.markAt = now;
      if (mark.priceUsd > pos.peakPriceUsd) pos.peakPriceUsd = mark.priceUsd;
      const pnl = mark.priceUsd / pos.entryPriceUsd - 1;
      if (pnl >= limits.trailArmPct) pos.trailArmed = true;
    }
    const decision = decideExit(
      pos,
      {
        now,
        sessionStartedAt: book.sessionStartedAt,
        quoteOutSol: mark?.quoteOutSol,
        quoteOk: mark?.quoteOk,
      },
      limits
    );
    decisions.push(decision);
    if (decision.action === "hold") {
      stillOpen.push(pos);
      continue;
    }
    const out = markOutSol(pos, pos.markPriceUsd, limits) ?? pos.costSol;
    const sold = out * decision.fraction;
    const costSold = pos.costSol * decision.fraction;
    const realized = realizedFromExit(sold, costSold, book.solUsd);
    book.closed.push({
      mint: pos.mint,
      lane: pos.lane,
      costSol: costSold,
      exitSol: sold,
      solUsd: book.solUsd,
      closedAt: now,
      reason: decision.reason,
    });
    book.freeSol += sold;
    book.wavePnlSol += realized.pnlSol;
    if (decision.action === "partial") {
      pos.costSol = Math.max(0, pos.costSol - costSold);
      pos.tpNet10Taken = true;
      pos.tpNet10Armed = true;
      if (decision.label === "risk_tp1") pos.riskTp1Taken = true;
      if (decision.label === "risk_tp2") pos.riskTp2Taken = true;
      stillOpen.push(pos);
    } else {
      pos.status = "CLOSED";
      book.cooldowns[pos.mint] =
        now + (decision.label === "hard_stop" ? limits.rebuyCooldownMs : limits.rebuyCooldownMs);
      const split = splitWaveProfit(book.wavePnlSol, book.equitySol, limits);
      book.pendingReinvestSol += split.reinvest;
      book.reserveSol += split.reserve;
      book.netSol += split.net;
      book.wavePnlSol = 0;
    }
  }
  book.positions = stillOpen;
  const marked = book.positions.reduce(
    (sum, pos) => sum + (markOutSol(pos, pos.markPriceUsd, limits) ?? pos.costSol),
    0
  );
  book.equitySol = book.freeSol + book.reserveSol + book.netSol + marked;
  return decisions;
}
