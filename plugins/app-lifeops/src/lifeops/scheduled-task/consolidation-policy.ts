/**
 * Wave-1 frozen registry: AnchorContribution + AnchorConsolidationPolicy
 * (W1-A).
 *
 * Source of truth: `docs/audit/wave1-interfaces.md` §1.4 + IMPL §3.1.
 *
 * Wave-1 ships the registry shape + a stub `wake.confirmed` anchor that
 * resolves to `ownerFact.morningWindow.start` (per IMPL §3.1
 * "Risk-and-tradeoff: Stub anchor resolution"). W1-B's `plugin-health`
 * registers the real `wake.observed` / `wake.confirmed` / `bedtime.target`
 * / `nap.start` anchors and may overwrite the stub at boot — so the stub
 * is only registered when the real one is absent.
 *
 * Consolidation policies are referenced by anchor key. The runner uses
 * them when multiple `relative_to_anchor` tasks fire on the same anchor;
 * `mode = "merge"` means the runner asks consumers to render one
 * combined card; `sequential` staggers; `parallel` fires all at once.
 */

import type {
  AnchorContext,
  AnchorContribution,
  AnchorConsolidationPolicy,
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
// Stub anchor resolver — Wave 1
// ---------------------------------------------------------------------------

function todayIsoWithLocalHHMM(
  nowIso: string,
  hhmm: string,
  tz: string,
): { atIso: string } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "0", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  // Start from the local-date string for the given tz, then construct an
  // ISO that represents that local hour/minute.
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(nowIso));
    const y = Number.parseInt(
      parts.find((p) => p.type === "year")?.value ?? "1970",
      10,
    );
    const mo = Number.parseInt(
      parts.find((p) => p.type === "month")?.value ?? "01",
      10,
    );
    const d = Number.parseInt(
      parts.find((p) => p.type === "day")?.value ?? "01",
      10,
    );
    // Build a UTC iso then offset by the tz offset from this date.
    // Simplest correct approach: ask Intl for the offset minutes for this
    // local datetime by formatting an offset.
    const localDate = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));
    // Compute the offset by formatting localDate in the tz and reading
    // longOffset; fall back to UTC if not supported.
    const offsetFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const tzParts = offsetFormatter.formatToParts(localDate);
    const offsetStr =
      tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const offsetMatch = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(offsetStr);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1]?.startsWith("-") ? -1 : 1;
      const oh = Math.abs(Number.parseInt(offsetMatch[1] ?? "0", 10));
      const om = Number.parseInt(offsetMatch[2] ?? "0", 10);
      offsetMinutes = sign * (oh * 60 + om);
    }
    const atMs = localDate.getTime() - offsetMinutes * 60_000;
    return { atIso: new Date(atMs).toISOString() };
  } catch {
    return null;
  }
}

const stubWakeConfirmedAnchor: AnchorContribution = {
  anchorKey: "wake.confirmed",
  describe: {
    label: "Wake confirmed (stub: ownerFact.morningWindow.start)",
    provider: "@elizaos/app-lifeops:scheduled-task:stub",
  },
  resolve(context) {
    const tz = context.ownerFacts.timezone ?? "UTC";
    const start = context.ownerFacts.morningWindow?.start;
    if (!start) return null;
    return todayIsoWithLocalHHMM(context.nowIso, start, tz);
  },
};

export function registerStubAnchors(reg: AnchorRegistry): void {
  if (!reg.get("wake.confirmed")) {
    reg.register(stubWakeConfirmedAnchor);
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
        throw new Error(
          "ConsolidationRegistry.register: anchorKey required",
        );
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

      const cap = policy.maxBatchSize && policy.maxBatchSize > 0
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

export const __anchorTestUtils = { todayIsoWithLocalHHMM };
