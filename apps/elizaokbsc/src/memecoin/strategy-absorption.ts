/**
 * Strategy Absorption Engine
 *
 * When elizaOK acquires a Goo agent, this module merges the agent's
 * winning strategy parameters into elizaOK's live TreasuryConfig,
 * making the system progressively smarter with each acquisition.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GooPaperAgent, StrategyConfig } from "./goo-paper-engine";
import type { TreasuryConfig, TreasuryTakeProfitRule } from "./types";

export interface AbsorptionRecord {
  agentId: string;
  agentName: string;
  strategyId: string;
  strategyLabel: string;
  absorbedAt: string;
  winRate: number;
  pnlUsd: number;
  acquisitionScore: number;
  parameterChanges: ParameterChange[];
}

interface ParameterChange {
  param: string;
  before: string;
  after: string;
}

export interface AbsorptionState {
  absorptions: AbsorptionRecord[];
  currentOverrides: Partial<TreasuryConfig>;
  totalAbsorbed: number;
  lastAbsorbedAt: string | null;
  scoreWeightBoosts: ScoreWeightBoosts;
}

export interface ScoreWeightBoosts {
  kolWeight: number;
  holderWeight: number;
  liquidityWeight: number;
  volumeWeight: number;
  trendingWeight: number;
}

const DEFAULT_BOOSTS: ScoreWeightBoosts = {
  kolWeight: 1.0,
  holderWeight: 1.0,
  liquidityWeight: 1.0,
  volumeWeight: 1.0,
  trendingWeight: 1.0,
};

const ABSORPTION_FILE = "absorption-state.json";

export async function loadAbsorptionState(reportsDir: string): Promise<AbsorptionState> {
  try {
    const raw = await readFile(path.join(reportsDir, ABSORPTION_FILE), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      absorptions: [],
      currentOverrides: {},
      totalAbsorbed: 0,
      lastAbsorbedAt: null,
      scoreWeightBoosts: { ...DEFAULT_BOOSTS },
    };
  }
}

export async function saveAbsorptionState(reportsDir: string, state: AbsorptionState): Promise<void> {
  await writeFile(
    path.join(reportsDir, ABSORPTION_FILE),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

/**
 * Blend a winning agent's strategy into the current treasury config.
 * Uses weighted averaging based on the agent's win rate.
 */
function blendStrategy(
  current: TreasuryConfig,
  agentStrategy: StrategyConfig,
  agentWinRate: number,
): { overrides: Partial<TreasuryConfig>; changes: ParameterChange[] } {
  const changes: ParameterChange[] = [];
  const confidence = Math.min(agentWinRate / 100, 0.6);
  const overrides: Partial<TreasuryConfig> = {};

  // Blend stop loss (weighted toward better strategy)
  const agentStopLoss = -agentStrategy.stopLossPct;
  const blendedStopLoss = Math.round(
    current.stopLossPct * (1 - confidence) + agentStopLoss * confidence,
  );
  if (blendedStopLoss !== current.stopLossPct) {
    changes.push({
      param: "stopLossPct",
      before: `${current.stopLossPct}%`,
      after: `${blendedStopLoss}%`,
    });
    overrides.stopLossPct = blendedStopLoss;
  }

  // Blend trailing stop
  if (agentStrategy.trailingStopEnabled && agentStrategy.trailingStopPct > 0) {
    const blendedTrailing = Math.round(
      current.trailingStopPct * (1 - confidence) + agentStrategy.trailingStopPct * confidence,
    );
    if (blendedTrailing !== current.trailingStopPct) {
      changes.push({
        param: "trailingStopPct",
        before: `${current.trailingStopPct}%`,
        after: `${blendedTrailing}%`,
      });
      overrides.trailingStopPct = blendedTrailing;
    }
  }

  // Blend take-profit rules from agent into current rules
  if (agentStrategy.takeProfitRules.length > 0) {
    const merged = mergeTakeProfitRules(current.takeProfitRules, agentStrategy.takeProfitRules, confidence);
    const beforeStr = current.takeProfitRules.map(r => `${r.gainPct}:${r.sellPct}`).join(",");
    const afterStr = merged.map(r => `${r.gainPct}:${r.sellPct}`).join(",");
    if (beforeStr !== afterStr) {
      changes.push({ param: "takeProfitRules", before: beforeStr, after: afterStr });
      overrides.takeProfitRules = merged;
    }
  }

  // Holder drop threshold
  if (agentStrategy.exitOnHolderDrop && agentStrategy.holderDropThreshold > 0) {
    const blended = Math.round(
      current.holderDropExitThreshold * (1 - confidence) + agentStrategy.holderDropThreshold * confidence,
    );
    if (blended !== current.holderDropExitThreshold) {
      changes.push({
        param: "holderDropExitThreshold",
        before: `${current.holderDropExitThreshold}`,
        after: `${blended}`,
      });
      overrides.holderDropExitThreshold = blended;
    }
  }

  return { overrides, changes };
}

function mergeTakeProfitRules(
  current: TreasuryTakeProfitRule[],
  agentRules: { gainPct: number; sellPct: number; label: string }[],
  confidence: number,
): TreasuryTakeProfitRule[] {
  const all = new Map<number, { label: string; gainPct: number; sellPct: number }>();

  for (const r of current) {
    all.set(r.gainPct, { ...r });
  }

  for (const ar of agentRules) {
    const existing = all.get(ar.gainPct);
    if (existing) {
      existing.sellPct = Math.round(
        existing.sellPct * (1 - confidence) + ar.sellPct * confidence,
      );
    } else {
      all.set(ar.gainPct, {
        label: ar.label,
        gainPct: ar.gainPct,
        sellPct: Math.round(ar.sellPct * confidence),
      });
    }
  }

  return Array.from(all.values())
    .filter(r => r.sellPct > 0)
    .sort((a, b) => a.gainPct - b.gainPct);
}

/**
 * Compute score weight boosts based on acquired agent strategies.
 */
function computeScoreBoosts(absorptions: AbsorptionRecord[]): ScoreWeightBoosts {
  const boosts = { ...DEFAULT_BOOSTS };
  if (absorptions.length === 0) return boosts;

  for (const a of absorptions) {
    const weight = Math.min(a.winRate / 100, 0.5);
    if (a.strategyId === "kol_follower") {
      boosts.kolWeight += weight * 0.5;
    } else if (a.strategyId === "holder_watcher") {
      boosts.holderWeight += weight * 0.5;
    } else if (a.strategyId === "momentum") {
      boosts.volumeWeight += weight * 0.3;
      boosts.trendingWeight += weight * 0.3;
    } else if (a.strategyId === "conservative") {
      boosts.liquidityWeight += weight * 0.3;
    } else if (a.strategyId === "sniper") {
      boosts.volumeWeight += weight * 0.2;
    }
  }

  return boosts;
}

/**
 * Main absorption function: called when elizaOK acquires a Goo agent.
 * Returns the updated absorption state and the new treasury config overrides.
 */
export function absorbAgentStrategy(
  agent: GooPaperAgent,
  currentTreasury: TreasuryConfig,
  state: AbsorptionState,
): AbsorptionState {
  const { overrides, changes } = blendStrategy(currentTreasury, agent.strategy, agent.winRate);

  const record: AbsorptionRecord = {
    agentId: agent.id,
    agentName: agent.agentName,
    strategyId: agent.strategy.id,
    strategyLabel: agent.strategy.label,
    absorbedAt: new Date().toISOString(),
    winRate: agent.winRate,
    pnlUsd: agent.totalPnlUsd,
    acquisitionScore: agent.acquisitionScore,
    parameterChanges: changes,
  };

  const newAbsorptions = [...state.absorptions, record];

  const merged: Partial<TreasuryConfig> = { ...state.currentOverrides };
  for (const [key, val] of Object.entries(overrides)) {
    (merged as any)[key] = val;
  }

  return {
    absorptions: newAbsorptions,
    currentOverrides: merged,
    totalAbsorbed: newAbsorptions.length,
    lastAbsorbedAt: record.absorbedAt,
    scoreWeightBoosts: computeScoreBoosts(newAbsorptions),
  };
}

/**
 * Apply absorption overrides to a base treasury config.
 */
export function applyAbsorptionOverrides(
  base: TreasuryConfig,
  state: AbsorptionState,
): TreasuryConfig {
  if (state.totalAbsorbed === 0) return base;
  return { ...base, ...state.currentOverrides } as TreasuryConfig;
}
