/**
 * Post-first-run goal-discovery lifecycle state.
 *
 * After first-run setup completes, the assistant's next discovery job is to
 * learn what the owner actually wants help with. This store owns the
 * `pending` → `complete` lifecycle for that discovery: the `ftuGoal` provider
 * surfaces its affordance while `pending`, and the `ftu_goal_discovery`
 * evaluator flips it to `complete` exactly once when a high-confidence goal
 * is extracted. The goal VALUE itself is canonical in the `OwnerFactStore`
 * (`primaryGoal`); this record keeps only the lifecycle plus a discovery
 * snapshot for audit.
 *
 * Persistence: cache-backed (same durability pattern as
 * `FirstRunStateStore`), never in-memory only.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";

export type FtuGoalStatus = "pending" | "complete";

export interface DiscoveredFtuGoal {
  /** One compact sentence, in the owner's own terms. */
  goal: string;
  /** Extraction confidence in [0, 1] at the time the state flipped. */
  confidence: number;
  /** ISO-8601 instant the goal was recorded. */
  discoveredAt: string;
  /** Message id the extraction keyed off, when known. */
  sourceMessageId?: string;
}

export interface FtuGoalRecord {
  status: FtuGoalStatus;
  goal?: DiscoveredFtuGoal;
}

export interface FtuGoalStateStore {
  read(): Promise<FtuGoalRecord>;
  /** Flip to `complete` with the discovered goal snapshot. Idempotent: a second call overwrites the snapshot but the status stays `complete`. */
  complete(goal: DiscoveredFtuGoal): Promise<FtuGoalRecord>;
  /** Clear the lifecycle back to `pending` (tests / owner-requested re-discovery). */
  reset(): Promise<void>;
}

const FTU_GOAL_CACHE_KEY = "eliza:lifeops:ftu-goal:v1";

const EMPTY_RECORD: FtuGoalRecord = { status: "pending" };

function normalizeGoal(value: unknown): DiscoveredFtuGoal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const goal = typeof v.goal === "string" ? v.goal.trim() : "";
  const confidence =
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    v.confidence >= 0 &&
    v.confidence <= 1
      ? v.confidence
      : null;
  const discoveredAt =
    typeof v.discoveredAt === "string" &&
    Number.isFinite(Date.parse(v.discoveredAt))
      ? v.discoveredAt
      : null;
  if (!goal || confidence === null || discoveredAt === null) {
    return undefined;
  }
  const normalized: DiscoveredFtuGoal = { goal, confidence, discoveredAt };
  if (typeof v.sourceMessageId === "string" && v.sourceMessageId.length > 0) {
    normalized.sourceMessageId = v.sourceMessageId;
  }
  return normalized;
}

function normalizeRecord(value: unknown): FtuGoalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_RECORD };
  }
  const v = value as Record<string, unknown>;
  const goal = normalizeGoal(v.goal);
  // A `complete` status without a valid goal snapshot is a corrupt record;
  // treat it as pending so discovery re-runs instead of silently stalling.
  if (v.status === "complete" && goal) {
    return { status: "complete", goal };
  }
  return { ...EMPTY_RECORD };
}

export function createFtuGoalStateStore(
  runtime: IAgentRuntime,
): FtuGoalStateStore {
  const cache = asCacheRuntime(runtime);

  const read = async (): Promise<FtuGoalRecord> => {
    const stored = await cache.getCache<FtuGoalRecord>(FTU_GOAL_CACHE_KEY);
    return normalizeRecord(stored);
  };

  return {
    read,
    async complete(goal: DiscoveredFtuGoal): Promise<FtuGoalRecord> {
      const normalized = normalizeGoal(goal);
      if (!normalized) {
        throw new Error(
          "[ftu-goal-state] complete() requires a goal with goal text, confidence in [0,1], and an ISO discoveredAt",
        );
      }
      const next: FtuGoalRecord = { status: "complete", goal: normalized };
      await cache.setCache<FtuGoalRecord>(FTU_GOAL_CACHE_KEY, next);
      return { status: next.status, goal: { ...normalized } };
    },
    async reset(): Promise<void> {
      if (typeof cache.deleteCache === "function") {
        await cache.deleteCache(FTU_GOAL_CACHE_KEY);
      } else {
        await cache.setCache<FtuGoalRecord>(FTU_GOAL_CACHE_KEY, {
          ...EMPTY_RECORD,
        });
      }
    },
  };
}
