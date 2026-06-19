/**
 * First-run lifecycle state.
 *
 * Owns the `pending` → `in_progress` → `complete` lifecycle and the
 * Q-by-Q `partialAnswers` accumulator used by the customize path. The
 * canonical owner-fact store lives in `../owner/fact-store.ts`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";

// --- Public re-exports of the canonical OwnerFactStore --------------------

export type {
  EscalationRule,
  OwnerFactEntry,
  OwnerFactProvenance,
  OwnerFactProvenanceSource,
  OwnerFactStore,
  OwnerFacts,
  OwnerFactsPatch,
  OwnerFactWindow,
  OwnerQuietHours,
  PolicyPatchEscalationRule,
  PolicyPatchReminderIntensity,
  ReminderIntensity,
} from "../owner/fact-store.js";
export {
  createOwnerFactStore,
  getOwnerFactStore,
  ownerFactsToView,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";

// --- First-run lifecycle state -------------------------------------------

export type FirstRunPath = "defaults" | "customize" | "replay";

export type FirstRunStatus = "pending" | "in_progress" | "complete";

export interface FirstRunRecord {
  status: FirstRunStatus;
  path?: FirstRunPath;
  /** Q-by-Q answers persisted as the customize flow advances. */
  partialAnswers: Record<string, unknown>;
  /** First time this user kicked off first-run. */
  startedAt?: string;
  /** Set when status flipped to `complete`. */
  completedAt?: string;
  /** Number of completed runs (replay increments this). */
  completionCount: number;
}

const FIRST_RUN_CACHE_KEY = "eliza:lifeops:first-run:v1";

export interface FirstRunStateStore {
  read(): Promise<FirstRunRecord>;
  begin(path: FirstRunPath): Promise<FirstRunRecord>;
  recordAnswer(key: string, value: unknown): Promise<FirstRunRecord>;
  abandon(): Promise<FirstRunRecord>;
  complete(): Promise<FirstRunRecord>;
  /** Reset the lifecycle entirely and replay re-entry. */
  reset(): Promise<void>;
}

const EMPTY_RECORD: FirstRunRecord = {
  status: "pending",
  partialAnswers: {},
  completionCount: 0,
};

function cloneRecord(record: FirstRunRecord): FirstRunRecord {
  return {
    status: record.status,
    ...(record.path ? { path: record.path } : {}),
    partialAnswers: { ...record.partialAnswers },
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    completionCount: record.completionCount,
  };
}

function normalizeRecord(value: unknown): FirstRunRecord {
  if (!value || typeof value !== "object") {
    return cloneRecord(EMPTY_RECORD);
  }
  const v = value as Record<string, unknown>;
  const status =
    v.status === "pending" ||
    v.status === "in_progress" ||
    v.status === "complete"
      ? v.status
      : "pending";
  const path =
    v.path === "defaults" || v.path === "customize" || v.path === "replay"
      ? v.path
      : undefined;
  const partialAnswers =
    v.partialAnswers && typeof v.partialAnswers === "object"
      ? { ...(v.partialAnswers as Record<string, unknown>) }
      : {};
  const completionCount =
    typeof v.completionCount === "number" && v.completionCount >= 0
      ? Math.floor(v.completionCount)
      : 0;
  const record: FirstRunRecord = {
    status,
    partialAnswers,
    completionCount,
  };
  if (path !== undefined) record.path = path;
  if (typeof v.startedAt === "string" && v.startedAt) {
    record.startedAt = v.startedAt;
  }
  if (typeof v.completedAt === "string" && v.completedAt) {
    record.completedAt = v.completedAt;
  }
  return record;
}

export function createFirstRunStateStore(
  runtime: IAgentRuntime,
): FirstRunStateStore {
  const cache = asCacheRuntime(runtime);

  const persist = async (next: FirstRunRecord): Promise<FirstRunRecord> => {
    await cache.setCache<FirstRunRecord>(FIRST_RUN_CACHE_KEY, next);
    return cloneRecord(next);
  };

  const read = async (): Promise<FirstRunRecord> => {
    const stored = await cache.getCache<FirstRunRecord>(FIRST_RUN_CACHE_KEY);
    return cloneRecord(normalizeRecord(stored));
  };

  return {
    read,
    async begin(path: FirstRunPath): Promise<FirstRunRecord> {
      const current = await read();
      const startedAt = current.startedAt ?? new Date().toISOString();
      const next: FirstRunRecord = {
        status: "in_progress",
        path,
        partialAnswers:
          path === "replay"
            ? {} // replay starts a fresh answer slate; existing facts persist independently
            : current.partialAnswers,
        startedAt,
        completionCount: current.completionCount,
      };
      if (current.completedAt) {
        next.completedAt = current.completedAt;
      }
      return await persist(next);
    },
    async recordAnswer(key: string, value: unknown): Promise<FirstRunRecord> {
      if (!key || typeof key !== "string") {
        throw new Error("[first-run-state] recordAnswer requires a key");
      }
      const current = await read();
      const next: FirstRunRecord = {
        ...current,
        partialAnswers: { ...current.partialAnswers, [key]: value },
        status: current.status === "complete" ? "complete" : "in_progress",
      };
      return await persist(next);
    },
    async abandon(): Promise<FirstRunRecord> {
      const current = await read();
      // Abandon keeps partialAnswers so resume works; status remains
      // `in_progress` if anything was answered, else flips back to `pending`.
      const hasProgress =
        Object.keys(current.partialAnswers).length > 0 || !!current.path;
      const next: FirstRunRecord = {
        ...current,
        status: hasProgress ? "in_progress" : "pending",
      };
      return await persist(next);
    },
    async complete(): Promise<FirstRunRecord> {
      const current = await read();
      const next: FirstRunRecord = {
        ...current,
        status: "complete",
        completedAt: new Date().toISOString(),
        completionCount: current.completionCount + 1,
      };
      return await persist(next);
    },
    async reset(): Promise<void> {
      if (typeof cache.deleteCache === "function") {
        await cache.deleteCache(FIRST_RUN_CACHE_KEY);
      } else {
        await cache.setCache<FirstRunRecord>(
          FIRST_RUN_CACHE_KEY,
          cloneRecord(EMPTY_RECORD),
        );
      }
    },
  };
}

export const FIRST_RUN_AFFORDANCE_PATHS: ReadonlyArray<
  "defaults" | "customize"
> = ["defaults", "customize"];
