/**
 * Escalation evaluator.
 *
 * Snooze policy: snooze RESETS the ladder to step 0 at the new fire time.
 * Default ladders by priority (when `escalation` is undefined):
 *   - low    → no ladder (single attempt)
 *   - medium → 1 retry @ 30 min
 *   - high   → 3-step cross-channel
 *
 * Callers may register additional named ladders that override
 * `priority_<level>_default` keys.
 */

import type {
  EscalationStep,
  ScheduledTask,
  ScheduledTaskEscalation,
  ScheduledTaskPriority,
} from "./types.js";

export interface EscalationLadder {
  ladderKey: string;
  steps: EscalationStep[];
}

export interface EscalationLadderRegistry {
  register(ladder: EscalationLadder, opts?: { override?: boolean }): void;
  get(ladderKey: string): EscalationLadder | null;
  list(): EscalationLadder[];
}

export function createEscalationLadderRegistry(): EscalationLadderRegistry {
  const map = new Map<string, EscalationLadder>();
  return {
    register(ladder, opts) {
      if (!ladder.ladderKey || typeof ladder.ladderKey !== "string") {
        throw new Error(
          "EscalationLadderRegistry.register: ladderKey required",
        );
      }
      if (map.has(ladder.ladderKey) && !opts?.override) {
        throw new Error(
          `EscalationLadderRegistry.register: duplicate ladderKey "${ladder.ladderKey}"`,
        );
      }
      map.set(ladder.ladderKey, ladder);
    },
    get(key) {
      return map.get(key) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
  };
}

export const PRIORITY_DEFAULT_LADDER_KEYS: Record<
  ScheduledTaskPriority,
  string
> = {
  low: "priority_low_default",
  medium: "priority_medium_default",
  high: "priority_high_default",
};

export const DEFAULT_ESCALATION_LADDERS: Readonly<
  Record<string, EscalationLadder>
> = Object.freeze({
  priority_low_default: { ladderKey: "priority_low_default", steps: [] },
  priority_medium_default: {
    ladderKey: "priority_medium_default",
    steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }],
  },
  priority_high_default: {
    ladderKey: "priority_high_default",
    steps: [
      { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
      { delayMinutes: 15, channelKey: "push", intensity: "normal" },
      { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
    ],
  },
});

export function registerDefaultEscalationLadders(
  reg: EscalationLadderRegistry,
): void {
  for (const ladder of Object.values(DEFAULT_ESCALATION_LADDERS)) {
    if (!reg.get(ladder.ladderKey)) {
      reg.register(ladder);
    }
  }
}

/**
 * Resolve the effective ladder for a task. Inline `escalation.steps` win
 * over `escalation.ladderKey` resolution. If neither is set, the
 * priority-default ladder is returned.
 */
export function resolveEffectiveLadder(
  task: ScheduledTask,
  registry: EscalationLadderRegistry,
): EscalationLadder {
  const explicit: ScheduledTaskEscalation | undefined = task.escalation;
  if (explicit?.steps && explicit.steps.length > 0) {
    return { ladderKey: explicit.ladderKey ?? "inline", steps: explicit.steps };
  }
  if (explicit?.ladderKey) {
    const named = registry.get(explicit.ladderKey);
    if (named) return named;
  }
  const fallbackKey = PRIORITY_DEFAULT_LADDER_KEYS[task.priority];
  const fallback = registry.get(fallbackKey);
  if (fallback) return fallback;
  return (
    DEFAULT_ESCALATION_LADDERS[fallbackKey] ?? {
      ladderKey: fallbackKey,
      steps: [],
    }
  );
}

export interface EscalationCursor {
  /** Current step index. -1 = not yet escalated. */
  stepIndex: number;
  /** ISO of the most recent dispatch (or task fire for step -1). */
  lastDispatchedAt: string;
}

/**
 * Compute the next escalation step (returns `null` when ladder exhausted).
 * `lastDispatchedAt` is the anchor for the next delay calculation.
 */
export function nextEscalationStep(
  ladder: EscalationLadder,
  cursor: EscalationCursor,
): { step: EscalationStep; nextStepIndex: number; fireAtIso: string } | null {
  const nextIdx = cursor.stepIndex + 1;
  if (nextIdx >= ladder.steps.length) {
    return null;
  }
  const step = ladder.steps[nextIdx];
  if (!step) return null;
  const lastMs = new Date(cursor.lastDispatchedAt).getTime();
  const fireAtMs = lastMs + (step.delayMinutes ?? 0) * 60_000;
  return {
    step,
    nextStepIndex: nextIdx,
    fireAtIso: new Date(fireAtMs).toISOString(),
  };
}

/**
 * Snooze resets the ladder to step 0 at the new fire time.
 * Returns the cursor the runner should persist post-snooze.
 */
export function resetLadderForSnooze(newFireAtIso: string): EscalationCursor {
  return {
    stepIndex: -1,
    lastDispatchedAt: newFireAtIso,
  };
}
