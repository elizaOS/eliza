/**
 * AnchorContribution + AnchorConsolidationPolicy registry.
 *
 * Ships a fallback `wake.confirmed` anchor that resolves to
 * `ownerFact.morningWindow.start`. `plugin-health` registers the richer
 * `wake.observed` / `wake.confirmed` / `bedtime.target` / `nap.start`
 * anchors and may overwrite the fallback at boot — so the fallback is only
 * registered when the real one is absent.
 *
 * Consolidation policies are referenced by anchor key. The runner uses
 * them when multiple `relative_to_anchor` tasks fire on the same anchor;
 * `mode = "merge"` means the runner asks consumers to render one
 * combined card; `sequential` staggers; `parallel` fires all at once.
 */

import { resolveLocalHHMMToIso } from "./local-time.js";
import type {
  AnchorConsolidationPolicy,
  AnchorContext,
  AnchorContribution,
  ScheduledTask,
  ScheduledTaskPriority,
} from "./types.js";

// ---------------------------------------------------------------------------
// Anchor registry
// ---------------------------------------------------------------------------

export interface AnchorRegistry {
  register(a: AnchorContribution, opts?: { override?: boolean }): void;
  get(anchorKey: string): AnchorContribution | null;
  list(): AnchorContribution[];
  resolve(
    anchorKey: string,
    context: AnchorContext,
  ): Promise<{ atIso: string } | null>;
}

export function createAnchorRegistry(): AnchorRegistry {
  const map = new Map<string, AnchorContribution>();
  return {
    register(a, opts) {
      if (!a.anchorKey || typeof a.anchorKey !== "string") {
        throw new Error("AnchorRegistry.register: anchorKey required");
      }
      if (map.has(a.anchorKey) && !opts?.override) {
        throw new Error(
          `AnchorRegistry.register: duplicate anchorKey "${a.anchorKey}"`,
        );
      }
      map.set(a.anchorKey, a);
    },
    get(key) {
      return map.get(key) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
    async resolve(key, context) {
      const anchor = map.get(key);
      if (!anchor) return null;
      const result = await anchor.resolve(context);
      return result ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback anchor resolver — Wave 1
// ---------------------------------------------------------------------------

function todayIsoWithLocalHHMM(
  nowIso: string,
  hhmm: string,
  tz: string,
): { atIso: string } | null {
  try {
    const atIso = resolveLocalHHMMToIso(new Date(nowIso), hhmm, tz);
    return atIso ? { atIso } : null;
  } catch {
    // error-policy:J3 owner-provided timezone data yields an explicit invalid anchor.
    return null;
  }
}

const fallbackWakeConfirmedAnchor: AnchorContribution = {
  anchorKey: "wake.confirmed",
  describe: {
    label: "Wake confirmed (ownerFact.morningWindow.start fallback)",
    provider: "@elizaos/plugin-personal-assistant:scheduled-task:fallback",
  },
  resolve(context) {
    const tz = context.ownerFacts.timezone ?? "UTC";
    const start = context.ownerFacts.morningWindow?.start;
    if (!start) return null;
    return todayIsoWithLocalHHMM(context.nowIso, start, tz);
  },
};

export function registerFallbackAnchors(reg: AnchorRegistry): void {
  if (!reg.get("wake.confirmed")) {
    reg.register(fallbackWakeConfirmedAnchor);
  }
}

// ---------------------------------------------------------------------------
// Consolidation registry
// ---------------------------------------------------------------------------

export interface ConsolidationRegistry {
  register(p: AnchorConsolidationPolicy): void;
  get(anchorKey: string): AnchorConsolidationPolicy | null;
  list(): AnchorConsolidationPolicy[];
  /**
   * Apply a policy to a fresh batch of tasks fired on the same anchor.
   * Returns batches the runner should hand to its dispatcher; each batch
   * is a list of tasks the consumer renders together (or sequentially —
   * the policy mode tells the consumer how).
   */
  consolidate(
    anchorKey: string,
    tasks: ScheduledTask[],
  ): { policy: AnchorConsolidationPolicy | null; batches: ScheduledTask[][] };
}

const PRIORITY_RANK: Record<ScheduledTaskPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function createConsolidationRegistry(): ConsolidationRegistry {
  const map = new Map<string, AnchorConsolidationPolicy>();
  return {
    register(p) {
      if (!p.anchorKey || typeof p.anchorKey !== "string") {
        throw new Error("ConsolidationRegistry.register: anchorKey required");
      }
      map.set(p.anchorKey, p);
    },
    get(key) {
      return map.get(key) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
    consolidate(anchorKey, tasks) {
      const policy = map.get(anchorKey) ?? null;
      if (!policy || tasks.length === 0) {
        return { policy, batches: tasks.map((t) => [t]) };
      }

      const sorted = [...tasks].sort((a, b) => {
        if (policy.sortBy === "priority_desc") {
          return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        }
        const aFired = a.state.firedAt ?? "";
        const bFired = b.state.firedAt ?? "";
        return aFired < bFired ? -1 : aFired > bFired ? 1 : 0;
      });

      const cap =
        policy.maxBatchSize && policy.maxBatchSize > 0
          ? policy.maxBatchSize
          : sorted.length;

      if (policy.mode === "merge") {
        const batches: ScheduledTask[][] = [];
        for (let i = 0; i < sorted.length; i += cap) {
          batches.push(sorted.slice(i, i + cap));
        }
        return { policy, batches };
      }

      // sequential & parallel both produce one task per batch — the
      // difference (stagger) is observable to the dispatcher via the
      // policy reference, not via batch shape.
      return {
        policy,
        batches: sorted.map((t) => [t]),
      };
    },
  };
}
