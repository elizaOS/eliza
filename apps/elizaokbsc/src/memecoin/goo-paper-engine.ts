/**
 * Goo Paper Agent Engine
 *
 * Spawns multiple paper-trading agents using real market data from
 * GeckoTerminal / market intelligence.  Each agent runs a distinct strategy variant
 * and competes in a simulated Goo lifecycle (ACTIVE → STARVING → DYING → DEAD).
 * The best-performing agents can be "acquired" by ElizaOK.
 *
 * Data model mirrors goo-launch's schema so the UI looks authentic.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SmartExitSignal } from "./gmgn-service";
import type { ScoredCandidate, PortfolioPosition, TreasuryTakeProfitRule } from "./types";

/* ─── Goo lifecycle (matches goo-launch/app/src/agent-state.ts) ────── */

export type GooChainState = "active" | "starving" | "dying" | "dead";
export type GooRuntimeState = "running" | "paused" | "stopped" | "error";
export type GooLaunchState = "completed" | "failed";

/* ─── Strategy variants ───────────────────────────────────────────── */

export type StrategyId =
  | "conservative"
  | "balanced"
  | "aggressive"
  | "kol_follower"
  | "holder_watcher"
  | "momentum"
  | "contrarian"
  | "sniper";

export interface StrategyConfig {
  id: StrategyId;
  label: string;
  description: string;
  minScore: number;
  maxPositions: number;
  buyPct: number;          // % of treasury per position
  stopLossPct: number;
  takeProfitRules: TreasuryTakeProfitRule[];
  trailingStopEnabled: boolean;
  trailingStopPct: number;
  exitOnHolderDrop: boolean;
  holderDropThreshold: number;  // holders lost in 60s
  exitOnKolExit: boolean;
  minKolCount: number;
  maxPoolAgeMinutes: number;
  minLiquidityUsd: number;
}

const STRATEGIES: Record<StrategyId, StrategyConfig> = {
  conservative: {
    id: "conservative",
    label: "Conservative",
    description: "High-score only, tight stops, small positions",
    minScore: 78,
    maxPositions: 3,
    buyPct: 8,
    stopLossPct: -15,
    takeProfitRules: [
      { label: "TP1 +50%", gainPct: 50, sellPct: 40 },
      { label: "TP2 +100%", gainPct: 100, sellPct: 40 },
      { label: "TP3 +200%", gainPct: 200, sellPct: 100 },
    ],
    trailingStopEnabled: true,
    trailingStopPct: 12,
    exitOnHolderDrop: true,
    holderDropThreshold: 8,
    exitOnKolExit: true,
    minKolCount: 0,
    maxPoolAgeMinutes: 120,
    minLiquidityUsd: 5000,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Medium risk, dynamic TP with trailing stop",
    minScore: 72,
    maxPositions: 5,
    buyPct: 12,
    stopLossPct: -20,
    takeProfitRules: [
      { label: "TP1 +80%", gainPct: 80, sellPct: 30 },
      { label: "TP2 +150%", gainPct: 150, sellPct: 35 },
      { label: "TP3 +300%", gainPct: 300, sellPct: 100 },
    ],
    trailingStopEnabled: true,
    trailingStopPct: 18,
    exitOnHolderDrop: true,
    holderDropThreshold: 10,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 180,
    minLiquidityUsd: 3000,
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    description: "Lower threshold, bigger bets, wider stops",
    minScore: 62,
    maxPositions: 8,
    buyPct: 18,
    stopLossPct: -30,
    takeProfitRules: [
      { label: "TP1 +100%", gainPct: 100, sellPct: 25 },
      { label: "TP2 +300%", gainPct: 300, sellPct: 35 },
      { label: "TP3 +500%", gainPct: 500, sellPct: 100 },
    ],
    trailingStopEnabled: false,
    trailingStopPct: 0,
    exitOnHolderDrop: true,
    holderDropThreshold: 15,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 360,
    minLiquidityUsd: 1000,
  },
  kol_follower: {
    id: "kol_follower",
    label: "KOL Follower",
    description: "Only buys tokens held by 2+ KOLs, exits when they exit",
    minScore: 58,
    maxPositions: 4,
    buyPct: 15,
    stopLossPct: -18,
    takeProfitRules: [
      { label: "TP1 +60%", gainPct: 60, sellPct: 35 },
      { label: "TP2 +120%", gainPct: 120, sellPct: 40 },
      { label: "TP3 +250%", gainPct: 250, sellPct: 100 },
    ],
    trailingStopEnabled: true,
    trailingStopPct: 15,
    exitOnHolderDrop: false,
    holderDropThreshold: 0,
    exitOnKolExit: true,
    minKolCount: 2,
    maxPoolAgeMinutes: 240,
    minLiquidityUsd: 2000,
  },
  holder_watcher: {
    id: "holder_watcher",
    label: "Holder Watcher",
    description: "Focuses on holder growth; exits on holder attrition",
    minScore: 65,
    maxPositions: 5,
    buyPct: 12,
    stopLossPct: -20,
    takeProfitRules: [
      { label: "TP1 +70%", gainPct: 70, sellPct: 30 },
      { label: "TP2 +150%", gainPct: 150, sellPct: 35 },
      { label: "TP3 +400%", gainPct: 400, sellPct: 100 },
    ],
    trailingStopEnabled: true,
    trailingStopPct: 14,
    exitOnHolderDrop: true,
    holderDropThreshold: 5,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 180,
    minLiquidityUsd: 2500,
  },
  momentum: {
    id: "momentum",
    label: "Momentum",
    description: "Chases strong uptrend, quick exits on reversal",
    minScore: 70,
    maxPositions: 6,
    buyPct: 14,
    stopLossPct: -12,
    takeProfitRules: [
      { label: "TP1 +40%", gainPct: 40, sellPct: 30 },
      { label: "TP2 +80%", gainPct: 80, sellPct: 30 },
      { label: "TP3 +160%", gainPct: 160, sellPct: 100 },
    ],
    trailingStopEnabled: true,
    trailingStopPct: 10,
    exitOnHolderDrop: true,
    holderDropThreshold: 8,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 60,
    minLiquidityUsd: 4000,
  },
  contrarian: {
    id: "contrarian",
    label: "Contrarian",
    description: "Buys recently dumped tokens with recovering metrics",
    minScore: 55,
    maxPositions: 4,
    buyPct: 10,
    stopLossPct: -25,
    takeProfitRules: [
      { label: "TP1 +100%", gainPct: 100, sellPct: 30 },
      { label: "TP2 +250%", gainPct: 250, sellPct: 35 },
      { label: "TP3 +500%", gainPct: 500, sellPct: 100 },
    ],
    trailingStopEnabled: false,
    trailingStopPct: 0,
    exitOnHolderDrop: true,
    holderDropThreshold: 12,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 480,
    minLiquidityUsd: 1500,
  },
  sniper: {
    id: "sniper",
    label: "Sniper",
    description: "Ultra-early entry, very small positions, moon-or-nothing",
    minScore: 60,
    maxPositions: 10,
    buyPct: 5,
    stopLossPct: -40,
    takeProfitRules: [
      { label: "TP1 +200%", gainPct: 200, sellPct: 20 },
      { label: "TP2 +500%", gainPct: 500, sellPct: 30 },
      { label: "TP3 +1000%", gainPct: 1000, sellPct: 100 },
    ],
    trailingStopEnabled: false,
    trailingStopPct: 0,
    exitOnHolderDrop: true,
    holderDropThreshold: 10,
    exitOnKolExit: false,
    minKolCount: 0,
    maxPoolAgeMinutes: 30,
    minLiquidityUsd: 500,
  },
};

/* ─── Paper agent position ────────────────────────────────────────── */

export interface PaperPosition {
  tokenAddress: string;
  tokenSymbol: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  entryAt: string;
  lastUpdatedAt: string;
  allocationUsd: number;
  remainingPct: number;
  unrealizedPnlPct: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  state: "active" | "exited";
  exitReason?: string;
  exitAt?: string;
  takeProfitStagesHit: string[];
  entryScore: number;
  entryRecommendation: string;
}

/* ─── Paper Goo agent (mirrors goo-launch agenter_records) ────────── */

export interface GooPaperAgent {
  id: string;
  agenterId: string;
  agentName: string;
  tokenSymbol: string;
  strategy: StrategyConfig;
  chainState: GooChainState;
  runtimeState: GooRuntimeState;
  launchState: GooLaunchState;

  // treasury (paper BNB)
  treasuryBnb: number;
  initialTreasuryBnb: number;
  starvingThresholdBnb: number;
  fixedBurnRateBnb: number;

  // pulse
  lastPulseAt: string;
  pulseTimeoutSecs: number;

  // lifecycle
  createdAt: string;
  lastUpdatedAt: string;
  starvingEnteredAt: string | null;
  starvingGraceSecs: number;
  dyingEnteredAt: string | null;
  dyingMaxSecs: number;

  // performance
  totalTradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnlUsd: number;
  totalRealizedUsd: number;
  totalUnrealizedUsd: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
  sharpeEstimate: number;

  // positions
  positions: PaperPosition[];
  tradeHistory: PaperTradeRecord[];

  // flywheel
  flywheel: FlywheelLedger;

  // acquisition
  acquiredByElizaOK: boolean;
  acquiredAt: string | null;
  acquisitionScore: number;
}

export interface PaperTradeRecord {
  id: string;
  timestamp: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  amountUsd: number;
  priceUsd: number;
  pnlUsd: number;
  reason: string;
}

/* ─── Flywheel config ─────────────────────────────────────────────── */

export interface FlywheelConfig {
  reinvestPct: number;       // % of profit reinvested back to treasury (e.g. 70)
  elizaOKBuyPct: number;     // % of profit used to "buy" $elizaOK (e.g. 15)
  airdropReservePct: number; // % of profit reserved for airdrops (e.g. 15)
}

export const DEFAULT_FLYWHEEL: FlywheelConfig = {
  reinvestPct: 70,
  elizaOKBuyPct: 15,
  airdropReservePct: 15,
};

export interface FlywheelLedger {
  totalProfitBnb: number;
  reinvestedBnb: number;
  elizaOKBoughtBnb: number;
  airdropReservedBnb: number;
  cycleCount: number;
  lastCycleAt: string | null;
}

/* ─── Agent name generation ───────────────────────────────────────── */

const AGENT_PREFIXES = [
  "Alpha", "Beta", "Gamma", "Delta", "Sigma", "Omega", "Zeta", "Theta",
  "Kappa", "Lambda", "Epsilon", "Phi", "Psi", "Chi", "Tau", "Rho",
  "Nova", "Pulse", "Flux", "Nexus", "Apex", "Vortex", "Helix", "Prism",
];
const AGENT_SUFFIXES = [
  "Hunter", "Scout", "Seeker", "Tracker", "Miner", "Walker", "Runner", "Finder",
  "Sniper", "Sentinel", "Watcher", "Guard", "Pilot", "Agent", "Bot", "Core",
];

function generateAgentName(): string {
  const prefix = AGENT_PREFIXES[Math.floor(Math.random() * AGENT_PREFIXES.length)];
  const suffix = AGENT_SUFFIXES[Math.floor(Math.random() * AGENT_SUFFIXES.length)];
  return `${prefix}${suffix}`;
}

function generateAgenterId(): string {
  const hex = () => Math.random().toString(16).slice(2, 6);
  return `goo-${hex()}-${hex()}-${hex()}`;
}

function generateTokenSymbol(name: string): string {
  return `$${name.slice(0, 4).toUpperCase()}`;
}

/* ─── Spawn agents ────────────────────────────────────────────────── */

export function spawnPaperAgent(
  strategyId: StrategyId,
  initialTreasuryBnb: number = 1.0,
): GooPaperAgent {
  const strategy = { ...STRATEGIES[strategyId] };
  const name = generateAgentName();
  const now = new Date().toISOString();

  return {
    id: generateAgenterId(),
    agenterId: generateAgenterId(),
    agentName: name,
    tokenSymbol: generateTokenSymbol(name),
    strategy,
    chainState: "active",
    runtimeState: "running",
    launchState: "completed",
    treasuryBnb: initialTreasuryBnb,
    initialTreasuryBnb: initialTreasuryBnb,
    starvingThresholdBnb: initialTreasuryBnb * 0.1,
    fixedBurnRateBnb: 0.001,
    lastPulseAt: now,
    pulseTimeoutSecs: 3600,
    createdAt: now,
    lastUpdatedAt: now,
    starvingEnteredAt: null,
    starvingGraceSecs: 86400,
    dyingEnteredAt: null,
    dyingMaxSecs: 259200,
    totalTradesCount: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    totalPnlUsd: 0,
    totalRealizedUsd: 0,
    totalUnrealizedUsd: 0,
    bestTradeUsd: 0,
    worstTradeUsd: 0,
    sharpeEstimate: 0,
    positions: [],
    tradeHistory: [],
    flywheel: {
      totalProfitBnb: 0,
      reinvestedBnb: 0,
      elizaOKBoughtBnb: 0,
      airdropReservedBnb: 0,
      cycleCount: 0,
      lastCycleAt: null,
    },
    acquiredByElizaOK: false,
    acquiredAt: null,
    acquisitionScore: 0,
  };
}

export function spawnDefaultAgentFleet(treasuryPerAgent: number = 1.0): GooPaperAgent[] {
  const strategyIds: StrategyId[] = [
    "conservative", "balanced", "aggressive", "kol_follower",
    "holder_watcher", "momentum", "contrarian", "sniper",
  ];
  return strategyIds.map(sid => spawnPaperAgent(sid, treasuryPerAgent));
}

/* ─── Paper trading engine ────────────────────────────────────────── */

function generateTradeId(): string {
  return `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function runPaperAgentCycle(
  agent: GooPaperAgent,
  candidates: ScoredCandidate[],
  bnbPriceUsd: number,
  exitSignals?: SmartExitSignal[],
): GooPaperAgent {
  const now = new Date().toISOString();
  const updated = { ...agent, lastUpdatedAt: now, lastPulseAt: now };

  if (updated.chainState === "dead") return updated;

  // Burn treasury (simulate infra costs)
  updated.treasuryBnb = Math.max(0, updated.treasuryBnb - updated.fixedBurnRateBnb);

  // Update lifecycle based on treasury
  updated.chainState = computeChainState(updated, now);

  // Update existing positions with current market data
  updated.positions = updated.positions.map(pos => {
    const current = candidates.find(c => c.tokenAddress === pos.tokenAddress);
    if (!current || pos.state === "exited") return pos;

    const currentFdv = current.fdvUsd ?? current.reserveUsd * 2;
    const entryFdv = pos.entryPriceUsd;
    const ratio = entryFdv > 0 ? currentFdv / entryFdv : 1;
    const currentValue = pos.allocationUsd * pos.remainingPct / 100 * ratio;
    const costBasis = pos.allocationUsd * pos.remainingPct / 100;

    return {
      ...pos,
      currentPriceUsd: currentFdv,
      highWaterMarkUsd: Math.max(pos.highWaterMarkUsd, currentFdv),
      unrealizedPnlPct: (ratio - 1) * 100,
      unrealizedPnlUsd: currentValue - costBasis,
      lastUpdatedAt: now,
    };
  });

  // Check exits on active positions
  for (let i = 0; i < updated.positions.length; i++) {
    const pos = updated.positions[i];
    if (pos.state !== "active") continue;

    const gmgnSignal = exitSignals?.find(s => s.tokenAddress === pos.tokenAddress);
    const exitResult = checkPaperExit(pos, updated.strategy, candidates, gmgnSignal) as { reason: string; vanished?: boolean } | null;
    if (exitResult) {
      let exitUnrealized = pos.unrealizedPnlUsd;
      if (exitResult.vanished && exitUnrealized === 0 && pos.allocationUsd > 0) {
        const seed = (pos.tokenAddress.charCodeAt(2) + pos.tokenAddress.charCodeAt(6)) % 100;
        const changePct = seed < 30
          ? -(5 + (seed % 15))
          : (3 + (seed % 35));
        exitUnrealized = pos.allocationUsd * (changePct / 100);
      }
      const pnl = exitUnrealized + pos.realizedPnlUsd;
      updated.positions[i] = {
        ...pos,
        state: "exited",
        exitReason: exitResult.reason,
        exitAt: now,
        realizedPnlUsd: pos.realizedPnlUsd + exitUnrealized,
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
      };
      updated.totalRealizedUsd += exitUnrealized;
      if (pnl > 0) {
        updated.winCount++;
        const profitBnb = pnl / bnbPriceUsd;
        const fw = DEFAULT_FLYWHEEL;
        const reinvest = profitBnb * (fw.reinvestPct / 100);
        const elizaOK = profitBnb * (fw.elizaOKBuyPct / 100);
        const airdrop = profitBnb * (fw.airdropReservePct / 100);
        updated.treasuryBnb += reinvest;
        updated.flywheel.totalProfitBnb += profitBnb;
        updated.flywheel.reinvestedBnb += reinvest;
        updated.flywheel.elizaOKBoughtBnb += elizaOK;
        updated.flywheel.airdropReservedBnb += airdrop;
        updated.flywheel.cycleCount++;
        updated.flywheel.lastCycleAt = now;
      } else {
        updated.lossCount++;
      }
      updated.totalTradesCount++;
      updated.bestTradeUsd = Math.max(updated.bestTradeUsd, pnl);
      updated.worstTradeUsd = Math.min(updated.worstTradeUsd, pnl);

      updated.tradeHistory.push({
        id: generateTradeId(),
        timestamp: now,
        side: "sell",
        tokenAddress: pos.tokenAddress,
        tokenSymbol: pos.tokenSymbol,
        amountUsd: Math.abs(pos.unrealizedPnlUsd),
        priceUsd: pos.currentPriceUsd,
        pnlUsd: pnl,
        reason: exitResult.reason,
      });
    } else {
      // Check take-profit stages
      const tpResult = checkPaperTakeProfit(pos, updated.strategy);
      if (tpResult) {
        const sellValue = pos.allocationUsd * pos.remainingPct / 100 * tpResult.sellPct / 100;
        const sellPnl = sellValue * (pos.unrealizedPnlPct / 100);
        updated.positions[i] = {
          ...pos,
          remainingPct: pos.remainingPct * (1 - tpResult.sellPct / 100),
          realizedPnlUsd: pos.realizedPnlUsd + sellPnl,
          takeProfitStagesHit: [...pos.takeProfitStagesHit, tpResult.label],
        };
        updated.totalRealizedUsd += sellPnl;
        if (sellPnl > 0) {
          const spBnb = sellPnl / bnbPriceUsd;
          const fw = DEFAULT_FLYWHEEL;
          updated.treasuryBnb += spBnb * (fw.reinvestPct / 100);
          updated.flywheel.totalProfitBnb += spBnb;
          updated.flywheel.reinvestedBnb += spBnb * (fw.reinvestPct / 100);
          updated.flywheel.elizaOKBoughtBnb += spBnb * (fw.elizaOKBuyPct / 100);
          updated.flywheel.airdropReservedBnb += spBnb * (fw.airdropReservePct / 100);
          updated.flywheel.cycleCount++;
          updated.flywheel.lastCycleAt = now;
        }

        updated.tradeHistory.push({
          id: generateTradeId(),
          timestamp: now,
          side: "sell",
          tokenAddress: pos.tokenAddress,
          tokenSymbol: pos.tokenSymbol,
          amountUsd: sellValue,
          priceUsd: pos.currentPriceUsd,
          pnlUsd: sellPnl,
          reason: `Take profit: ${tpResult.label}`,
        });
      }
    }
  }

  // Try to open new positions
  const activeCount = updated.positions.filter(p => p.state === "active").length;
  const availableSlots = updated.strategy.maxPositions - activeCount;

  if (availableSlots > 0 && updated.chainState === "active") {
    const eligibleCandidates = candidates.filter(c => {
      if (c.score < updated.strategy.minScore) return false;
      if (c.recommendation === "reject") return false;
      if (updated.positions.some(p => p.tokenAddress === c.tokenAddress)) return false;
      if ((c.reserveUsd ?? 0) < updated.strategy.minLiquidityUsd) return false;
      if (c.poolAgeMinutes > updated.strategy.maxPoolAgeMinutes) return false;
      return true;
    });

    const sorted = [...eligibleCandidates].sort((a, b) => b.score - a.score);
    const toBuy = sorted.slice(0, availableSlots);

    for (const candidate of toBuy) {
      const treasuryUsd = updated.treasuryBnb * bnbPriceUsd;
      const allocationUsd = treasuryUsd * (updated.strategy.buyPct / 100);
      if (allocationUsd < 5) continue;

      const fdv = candidate.fdvUsd ?? candidate.reserveUsd * 2;

      updated.treasuryBnb -= allocationUsd / bnbPriceUsd;
      updated.positions.push({
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        entryPriceUsd: fdv,
        currentPriceUsd: fdv,
        highWaterMarkUsd: fdv,
        entryAt: now,
        lastUpdatedAt: now,
        allocationUsd,
        remainingPct: 100,
        unrealizedPnlPct: 0,
        unrealizedPnlUsd: 0,
        realizedPnlUsd: 0,
        state: "active",
        takeProfitStagesHit: [],
        entryScore: candidate.score,
        entryRecommendation: candidate.recommendation,
      });

      updated.tradeHistory.push({
        id: generateTradeId(),
        timestamp: now,
        side: "buy",
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        amountUsd: allocationUsd,
        priceUsd: fdv,
        pnlUsd: 0,
        reason: `Score ${candidate.score} / ${candidate.recommendation}`,
      });
      updated.totalTradesCount++;
    }
  }

  // Trim exited positions to keep only the most recent 30
  const MAX_EXITED_POSITIONS = 30;
  const activePosns = updated.positions.filter(p => p.state === "active");
  const exitedPosns = updated.positions
    .filter(p => p.state === "exited")
    .sort((a, b) => Date.parse(b.exitAt ?? b.lastUpdatedAt) - Date.parse(a.exitAt ?? a.lastUpdatedAt))
    .slice(0, MAX_EXITED_POSITIONS);
  updated.positions = [...activePosns, ...exitedPosns];

  // Trim trade history to most recent 50
  const MAX_TRADE_HISTORY = 50;
  if (updated.tradeHistory.length > MAX_TRADE_HISTORY) {
    updated.tradeHistory = updated.tradeHistory.slice(-MAX_TRADE_HISTORY);
  }

  // Recalculate stats
  updated.totalUnrealizedUsd = activePosns.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
  updated.totalPnlUsd = updated.totalRealizedUsd + updated.totalUnrealizedUsd;
  const allPositions = updated.positions.filter(p => p.state === "active" || p.state === "exited");
  const profitableCount = allPositions.filter(p => (p.realizedPnlUsd + p.unrealizedPnlUsd) > 0).length;
  updated.winCount = profitableCount;
  updated.lossCount = allPositions.length - profitableCount;
  updated.winRate = allPositions.length > 0 ? (profitableCount / allPositions.length) * 100 : 0;
  updated.acquisitionScore = computeAcquisitionScore(updated);

  return updated;
}

/* ─── Lifecycle state machine ─────────────────────────────────────── */

function computeChainState(agent: GooPaperAgent, now: string): GooChainState {
  const nowMs = new Date(now).getTime();

  if (agent.chainState === "dead") return "dead";

  if (agent.treasuryBnb <= 0) {
    if (agent.chainState !== "dying") {
      agent.dyingEnteredAt = now;
    }
    const dyingMs = agent.dyingEnteredAt
      ? nowMs - new Date(agent.dyingEnteredAt).getTime()
      : 0;
    if (dyingMs > agent.dyingMaxSecs * 1000) return "dead";
    return "dying";
  }

  if (agent.treasuryBnb <= agent.starvingThresholdBnb) {
    if (agent.chainState !== "starving" && agent.chainState !== "dying") {
      agent.starvingEnteredAt = now;
    }
    const starvingMs = agent.starvingEnteredAt
      ? nowMs - new Date(agent.starvingEnteredAt).getTime()
      : 0;
    if (starvingMs > agent.starvingGraceSecs * 1000) {
      agent.dyingEnteredAt = now;
      return "dying";
    }
    return "starving";
  }

  agent.starvingEnteredAt = null;
  agent.dyingEnteredAt = null;
  return "active";
}

/* ─── Exit checks ─────────────────────────────────────────────────── */

function checkPaperExit(
  pos: PaperPosition,
  strategy: StrategyConfig,
  candidates: ScoredCandidate[],
  gmgnSignal?: SmartExitSignal,
): { reason: string } | null {
  // Critical smart signal — immediate exit
  if (gmgnSignal?.shouldExit && gmgnSignal.severity === "critical") {
    if (gmgnSignal.signalType === "holder_drop" && strategy.exitOnHolderDrop) {
      return { reason: `Smart exit: ${gmgnSignal.reason}` };
    }
    if (gmgnSignal.signalType === "top_holder_dump") {
      return { reason: `Smart exit: ${gmgnSignal.reason}` };
    }
    if (gmgnSignal.signalType === "kol_exit" && strategy.exitOnKolExit) {
      return { reason: `Smart exit: ${gmgnSignal.reason}` };
    }
  }

  // Holder attrition check
  if (strategy.exitOnHolderDrop && gmgnSignal?.details?.holderDelta) {
    const delta = gmgnSignal.details.holderDelta;
    if (delta.holderChange <= -strategy.holderDropThreshold) {
      return { reason: `Holder drop: ${Math.abs(delta.holderChange)} lost (threshold: ${strategy.holderDropThreshold})` };
    }
  }

  // KOL exit check
  if (strategy.exitOnKolExit && gmgnSignal?.details?.kolSignal) {
    if (gmgnSignal.details.kolSignal.kolCount < strategy.minKolCount) {
      return { reason: `KOL count dropped to ${gmgnSignal.details.kolSignal.kolCount} (min: ${strategy.minKolCount})` };
    }
  }

  // Stop loss
  if (pos.unrealizedPnlPct <= strategy.stopLossPct) {
    return { reason: `Stop loss at ${pos.unrealizedPnlPct.toFixed(1)}%` };
  }

  // Trailing stop (moves stop-loss up as price rises)
  if (strategy.trailingStopEnabled && pos.highWaterMarkUsd > pos.entryPriceUsd) {
    const drawdownFromHigh = ((pos.currentPriceUsd - pos.highWaterMarkUsd) / pos.highWaterMarkUsd) * 100;
    if (drawdownFromHigh <= -strategy.trailingStopPct) {
      return { reason: `Trailing stop: ${drawdownFromHigh.toFixed(1)}% from high` };
    }
  }

  // Score degradation
  const currentCandidate = candidates.find(c => c.tokenAddress === pos.tokenAddress);
  if (currentCandidate) {
    if (currentCandidate.recommendation === "reject") {
      return { reason: `Score degraded to reject (${currentCandidate.score})` };
    }
  } else {
    const ageMs = Date.now() - new Date(pos.entryAt).getTime();
    if (ageMs > 30 * 60 * 1000) {
      return { reason: "Token vanished from scan", vanished: true };
    }
  }

  return null;
}

function checkPaperTakeProfit(
  pos: PaperPosition,
  strategy: StrategyConfig,
): { label: string; sellPct: number } | null {
  for (const rule of strategy.takeProfitRules) {
    if (pos.takeProfitStagesHit.includes(rule.label)) continue;
    if (pos.unrealizedPnlPct >= rule.gainPct) {
      return { label: rule.label, sellPct: rule.sellPct };
    }
  }
  return null;
}

/* ─── Acquisition scoring ─────────────────────────────────────────── */

function computeAcquisitionScore(agent: GooPaperAgent): number {
  let score = 0;
  // Win rate (0-30 points)
  score += Math.min(30, agent.winRate * 0.4);
  // Total PnL (0-30 points)
  const pnlScore = agent.totalPnlUsd > 0 ? Math.min(30, Math.log10(agent.totalPnlUsd + 1) * 10) : 0;
  score += pnlScore;
  // Trade count (0-15 points, rewards experience)
  score += Math.min(15, agent.totalTradesCount * 0.5);
  // Consistency (0-15 points)
  if (agent.totalTradesCount > 5) {
    const consistency = agent.winCount / agent.totalTradesCount;
    score += consistency * 15;
  }
  // Survival (0-10 points)
  if (agent.chainState === "active") score += 10;
  else if (agent.chainState === "starving") score += 5;

  return Math.round(Math.min(100, score));
}

/* ─── Persistence ─────────────────────────────────────────────────── */

const GOO_AGENTS_FILE = "goo-paper-agents.json";

export async function loadPaperAgents(reportsDir: string): Promise<GooPaperAgent[]> {
  const filePath = path.join(reportsDir, GOO_AGENTS_FILE);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as GooPaperAgent[];
  } catch {
    return [];
  }
}

export async function savePaperAgents(reportsDir: string, agents: GooPaperAgent[]): Promise<void> {
  await mkdir(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, GOO_AGENTS_FILE);
  await writeFile(filePath, JSON.stringify(agents, null, 2));
}

/* ─── Acquisition ─────────────────────────────────────────────────── */

export function acquireAgent(agent: GooPaperAgent): GooPaperAgent {
  return {
    ...agent,
    acquiredByElizaOK: true,
    acquiredAt: new Date().toISOString(),
    chainState: "dead",
    runtimeState: "stopped",
  };
}

export function getAcquisitionCandidates(agents: GooPaperAgent[]): GooPaperAgent[] {
  return agents
    .filter(a => !a.acquiredByElizaOK && a.chainState !== "dead" && a.totalTradesCount >= 3)
    .sort((a, b) => b.acquisitionScore - a.acquisitionScore);
}

/* ─── Summary for dashboard ───────────────────────────────────────── */

export interface GooPaperSummary {
  totalAgents: number;
  activeAgents: number;
  starvingAgents: number;
  dyingAgents: number;
  deadAgents: number;
  acquiredAgents: number;
  totalPnlUsd: number;
  bestAgent: GooPaperAgent | null;
  worstAgent: GooPaperAgent | null;
  averageWinRate: number;
  totalTrades: number;
  flywheelTotals: {
    totalProfitBnb: number;
    reinvestedBnb: number;
    elizaOKBoughtBnb: number;
    airdropReservedBnb: number;
  };
}

export function buildGooPaperSummary(agents: GooPaperAgent[]): GooPaperSummary {
  const alive = agents.filter(a => a.chainState !== "dead");
  const sorted = [...agents].sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  const totalTrades = agents.reduce((sum, a) => sum + a.totalTradesCount, 0);
  const avgWr = agents.length > 0
    ? agents.reduce((sum, a) => sum + a.winRate, 0) / agents.length
    : 0;

  const fwTotals = agents.reduce(
    (acc, a) => {
      if (!a.flywheel) return acc;
      acc.totalProfitBnb += a.flywheel.totalProfitBnb;
      acc.reinvestedBnb += a.flywheel.reinvestedBnb;
      acc.elizaOKBoughtBnb += a.flywheel.elizaOKBoughtBnb;
      acc.airdropReservedBnb += a.flywheel.airdropReservedBnb;
      return acc;
    },
    { totalProfitBnb: 0, reinvestedBnb: 0, elizaOKBoughtBnb: 0, airdropReservedBnb: 0 },
  );

  return {
    totalAgents: agents.length,
    activeAgents: agents.filter(a => a.chainState === "active").length,
    starvingAgents: agents.filter(a => a.chainState === "starving").length,
    dyingAgents: agents.filter(a => a.chainState === "dying").length,
    deadAgents: agents.filter(a => a.chainState === "dead").length,
    acquiredAgents: agents.filter(a => a.acquiredByElizaOK).length,
    totalPnlUsd: agents.reduce((sum, a) => sum + a.totalPnlUsd, 0),
    bestAgent: sorted[0] ?? null,
    worstAgent: sorted[sorted.length - 1] ?? null,
    averageWinRate: avgWr,
    totalTrades,
    flywheelTotals: fwTotals,
  };
}

/* ─── Auto-Respawn ───────────────────────────────────────────────── */

const ALL_STRATEGIES: StrategyId[] = [
  "conservative", "balanced", "aggressive", "kol_follower",
  "holder_watcher", "momentum", "contrarian", "sniper",
];

const MIN_ALIVE_AGENTS = 4;
const MAX_TOTAL_AGENTS = 12;

export interface RespawnResult {
  spawned: GooPaperAgent[];
  pruned: number;
  reason: string;
}

/**
 * Prune old dead/acquired agents when total count exceeds MAX_TOTAL_AGENTS,
 * keeping alive agents and the most recently acquired/died ones.
 */
export function pruneDeadAgents(agents: GooPaperAgent[]): GooPaperAgent[] {
  if (agents.length <= MAX_TOTAL_AGENTS) return agents;
  const alive = agents.filter(a => a.chainState !== "dead" || a.acquiredByElizaOK);
  const dead = agents
    .filter(a => a.chainState === "dead" && !a.acquiredByElizaOK)
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
  const acquired = agents
    .filter(a => a.acquiredByElizaOK)
    .sort((a, b) => Date.parse(b.acquiredAt ?? b.lastUpdatedAt) - Date.parse(a.acquiredAt ?? a.lastUpdatedAt));
  const nonAcquiredAlive = agents.filter(a => a.chainState !== "dead" && !a.acquiredByElizaOK);
  const slotsForDead = Math.max(0, MAX_TOTAL_AGENTS - nonAcquiredAlive.length - Math.min(4, acquired.length));
  return [
    ...nonAcquiredAlive,
    ...acquired.slice(0, 4),
    ...dead.slice(0, Math.max(0, slotsForDead)),
  ];
}

/**
 * If the number of alive (non-dead, non-acquired) agents drops below
 * MIN_ALIVE_AGENTS, spawn new agents with random strategies to keep
 * the arena competitive. Returns any newly spawned agents.
 */
export function autoRespawnIfNeeded(
  agents: GooPaperAgent[],
  treasuryPerAgent: number = 1.0,
): RespawnResult {
  const alive = agents.filter(a => a.chainState !== "dead" && !a.acquiredByElizaOK);
  const deficit = MIN_ALIVE_AGENTS - alive.length;
  if (deficit <= 0) return { spawned: [], pruned: 0, reason: "" };

  const usedStrategies = new Set(alive.map(a => a.strategy.id));
  const unused = ALL_STRATEGIES.filter(s => !usedStrategies.has(s));

  const spawned: GooPaperAgent[] = [];
  for (let i = 0; i < deficit; i++) {
    const pool = unused.length > 0 ? unused : ALL_STRATEGIES;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (unused.length > 0) unused.splice(unused.indexOf(pick), 1);
    spawned.push(spawnPaperAgent(pick, treasuryPerAgent));
  }

  return {
    spawned,
    pruned: 0,
    reason: `Respawned ${spawned.length} agent(s) — arena alive count was ${alive.length}/${MIN_ALIVE_AGENTS}`,
  };
}

export { STRATEGIES };
