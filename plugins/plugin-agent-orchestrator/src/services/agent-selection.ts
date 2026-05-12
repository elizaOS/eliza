/**
 * Dynamic agent selection strategy.
 *
 * Chooses which coding-agent CLI to spawn when the caller does not
 * specify an explicit `agentType`.
 *
 *   - **fixed**  — always returns `config.fixedAgentType`
 *   - **ranked** — scores each installed agent on success rate,
 *                  stall frequency, and completion speed, then
 *                  returns the highest-scoring one
 *
 * @module services/agent-selection
 */

import type { AdapterType, PreflightResult } from "coding-agent-adapters";
// ── Types ────────────────────────────────────────────────────────────

export type AgentSelectionStrategy = "fixed" | "ranked";

/** Subset of AgentMetrics fields used for scoring. */
export interface AgentScoreInput {
  spawned: number;
  completed: number;
  stallCount: number;
  avgCompletionMs: number;
}

export interface AgentSelectionConfig {
  strategy: AgentSelectionStrategy;
  fixedAgentType: AdapterType;
}

export interface AgentSelectionContext {
  config: AgentSelectionConfig;
  /** Per-agent-type metrics snapshot (may be empty). */
  metrics: Record<string, AgentScoreInput>;
  /** Preflight results — only the `installed` ones are candidates. */
  installedAgents: PreflightResult[];
}

// ── Scoring ──────────────────────────────────────────────────────────

/**
 * Compute a 0–1 score for a single agent based on its metrics.
 *
 * - `successRate`  = completed / spawned  (0.5 neutral prior when no data)
 * - `volumeWeight` = min(1, spawned / 5)  — blends toward neutral at low N
 * - `stallPenalty`  = (stallCount / spawned) * 0.3
 * - `speedPenalty`  = min(avgCompletionMs / 300_000, 1) * 0.1  — weak tiebreaker
 *
 * Cold-start (no spawns): returns 0.5 so all agents are equal.
 */
export function computeAgentScore(
  metrics: AgentScoreInput | undefined,
): number {
  if (!metrics || metrics.spawned === 0) return 0.5;

  const { spawned, completed, stallCount, avgCompletionMs } = metrics;

  const rawSuccess = completed / spawned;
  const volumeWeight = Math.min(1, spawned / 5);
  const successRate = rawSuccess * volumeWeight + 0.5 * (1 - volumeWeight);

  const stallPenalty = (stallCount / spawned) * 0.3;
  const speedPenalty = Math.min(avgCompletionMs / 300_000, 1) * 0.1;

  return Math.max(0, successRate - stallPenalty - speedPenalty);
}

// ── Selection ────────────────────────────────────────────────────────

/** Default ordering when scores are tied — first entry wins. */
const DEFAULT_ORDER: AdapterType[] = ["claude", "gemini", "codex", "aider"];

/**
 * Select the best agent type given the current strategy, metrics, and
 * installed agents.
 *
 * Explicit user choice (`params.agentType`) should be resolved by the
 * caller *before* reaching this function.
 */
export function selectAgentType(ctx: AgentSelectionContext): AdapterType {
  if (ctx.config.strategy === "fixed") {
    return ctx.config.fixedAgentType;
  }

  // ── ranked mode ──
  const installed = new Set(
    ctx.installedAgents
      .filter((r) => r.installed)
      .map((r) => r.adapter as AdapterType),
  );

  // If nothing is installed, fall back to config default
  if (installed.size === 0) {
    return ctx.config.fixedAgentType;
  }

  let bestAgent: AdapterType = ctx.config.fixedAgentType;
  let bestScore = -1;

  for (const agent of DEFAULT_ORDER) {
    if (!installed.has(agent)) continue;
    const score = computeAgentScore(ctx.metrics[agent]);
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }

  return bestAgent;
}
