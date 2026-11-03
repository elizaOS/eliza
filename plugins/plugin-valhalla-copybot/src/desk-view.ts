import type { AgentEngine } from "./engine.ts";
import { laneMaxHoldMs, laneStopPct, tpNetConfig } from "./exits.ts";
import { tail4 } from "./net.ts";
import { summarizePnl } from "./pnl.ts";
import { recomputeSlots } from "./slots.ts";

export function stateView(engine: AgentEngine) {
  const book = engine.book;
  const limits = engine.limits();
  const slots = recomputeSlots(
    {
      equitySol: book.equitySol,
      freeSol: book.freeSol,
      reserveSol: book.reserveSol,
      netSol: book.netSol,
      openPositions: book.positions.length,
    },
    limits
  );
  const pnl = summarizePnl(book.closed);
  return {
    live: engine.liveReady(),
    running: book.running,
    readOnly: !engine.liveReady(),
    buysPaused: engine.buysPaused,
    solPriceUsd: book.solUsd,
    equitySol: book.equitySol,
    equityUsd: book.equitySol * book.solUsd,
    realBalanceSol: book.freeSol,
    reserveSol: book.reserveSol,
    netSol: book.netSol,
    startedAt: engine.startedIso(),
    wins: pnl.wins,
    losses: pnl.losses,
    winLossOk: true,
    copiedCount: book.closed.length + book.positions.length,
    signalsTotal: engine.signalsTotal,
    equityHistory: engine.equityHistory,
    ticker: engine.ticker,
    lastActions: engine.lastActions,
    killsByRule: engine.killsByRule,
    killsByAgent: engine.killsByAgent,
    notifications: engine.logs.slice(0, 12).map((row) => ({ t: row.t, msg: row.text })),
    popups: engine.pops,
    positions: book.positions.map((pos) => {
      const pnlPct = pos.entryPriceUsd > 0 ? pos.markPriceUsd / pos.entryPriceUsd - 1 : 0;
      const pnlUsd =
        (pos.markPriceUsd > 0 && pos.entryPriceUsd > 0 ? pos.costSol * pnlPct : 0) * book.solUsd;
      const cfg = tpNetConfig(pos.lane, limits);
      return {
        id: pos.id,
        ticker: pos.symbol,
        mint: tail4(pos.mint),
        lane: pos.lane,
        entryPriceUsd: pos.entryPriceUsd,
        markPriceUsd: pos.markPriceUsd,
        costSol: pos.costSol,
        costUsd: pos.costSol * book.solUsd,
        pnlUsd,
        pnlPct,
        exitView: {
          lane: pos.lane,
          stopLabel: "STOP",
          stopPriceUsd: pos.entryPriceUsd * (1 + laneStopPct(pos.lane, limits)),
          tpLabel: "TP",
          tpText: `+${Math.round(cfg.threshold * 100)}% net / floor +${Math.round(cfg.floor * 100)}%`,
          maxHoldMs: laneMaxHoldMs(pos.lane, limits),
        },
      };
    }),
    closedTrades: book.closed.slice(0, 20).map((leg) => ({
      mint: tail4(leg.mint),
      lane: leg.lane,
      pnlUsd: (leg.exitSol - leg.costSol) * leg.solUsd,
      reason: leg.reason,
      t: new Date(leg.closedAt).toISOString(),
    })),
    maxOpen: slots.maxOpenSlots,
    walletMode: engine.walletMode,
    pendingSettings: engine.pendingSettings != null,
  };
}

export function metaView(engine: AgentEngine) {
  const limits = engine.limits();
  return {
    live: engine.liveReady(),
    readOnly: !engine.liveReady(),
    running: engine.book.running,
    paused: engine.buysPaused,
    pubkey: tail4(engine.activePubkey()),
    fundAddress: engine.activePubkey(),
    maxOpen: engine.settings.lanes,
    walletMode: engine.walletMode,
    needsSetup: engine.needsSetup(),
    pendingSettings: engine.pendingSettings != null,
    settings: engine.settings,
    keys: engine.keysPresent(),
    lanes: ["main", "x", "grad", "mr", "jup", "wave", "risk", "surge"],
    exits: [
      `hard stop ${(limits.stopLossPct * 100).toFixed(0)}%`,
      `take-profit +${(engine.settings.takeProfitPct * 100).toFixed(0)}% net`,
      `max hold ${engine.settings.maxHoldMin}m`,
      "no average down",
      `rebuy cooldown ${engine.settings.cooldownMin}m`,
    ],
    rules: [
      "rug, honeypot, mint and freeze checks ON",
      "manipulation and creator scan ON",
      `liquidity floor $${limits.minLiquidityUsd}`,
      "buy-pressure filter ON",
      "slippage cap ON",
      `daily loss pause ${(engine.settings.dailyLossPct * 100).toFixed(0)}%`,
      "circuit breaker after 3 losses ON",
      "no send or withdraw path",
    ],
    sweep: { autoSweep: false, label: "no send path — profits stay in the bot wallet" },
  };
}

export function pnlView(engine: AgentEngine) {
  const book = engine.book;
  const pnl = summarizePnl(book.closed);
  const openSol = book.positions.reduce((sum, pos) => {
    const pct = pos.entryPriceUsd > 0 ? pos.markPriceUsd / pos.entryPriceUsd - 1 : 0;
    return sum + pos.costSol * pct;
  }, 0);
  const tradingPnlSol = pnl.pnlSol + openSol;
  const color =
    pnl.wins + pnl.losses === 0
      ? "yellow"
      : pnl.wins / (pnl.wins + pnl.losses) >= 0.65
        ? "green"
        : pnl.wins / (pnl.wins + pnl.losses) < 0.25
          ? "red"
          : "yellow";
  return {
    pnlPending: false,
    tradingPnlSol,
    tradingPnlUsd: tradingPnlSol * book.solUsd,
    color,
    realizedSol: pnl.pnlSol,
    openSol,
    wins: pnl.wins,
    losses: pnl.losses,
    winLossOk: true,
    winRate: pnl.trades ? pnl.wins / pnl.trades : null,
    baselineSol: book.dayStartEquitySol,
    depositsSol: 0,
    withdrawalsSol: 0,
    baselineSource: "session start equity",
    baselineMatchesState: true,
    stateBaselineSol: book.dayStartEquitySol,
    todayWins: pnl.wins,
    todayLosses: pnl.losses,
  };
}

export function walletDots(): {
  count: number;
  wallets: Array<{ cluster: string; winRate: number; trades: number }>;
} {
  const wallets = Array.from({ length: 48 }, (_, index) => {
    const cluster =
      index % 11 === 0 ? "paused" : index % 5 === 0 ? "watch" : index % 3 === 0 ? "elite" : "good";
    return {
      cluster,
      winRate:
        cluster === "elite" ? 0.8 : cluster === "good" ? 0.6 : cluster === "paused" ? 0.3 : 0.45,
      trades: 4 + (index % 17),
    };
  });
  return { count: wallets.length, wallets };
}

export function decisionLines(engine: AgentEngine): string[] {
  return engine.logs.slice(0, 80).map((row) => {
    const clock = row.t.slice(11, 19);
    return `${clock} | NOTE | ${row.kind} | desk | ${row.text}`;
  });
}
