/**
 * First-run state + interim `OwnerFactStore` wrapper.
 *
 * **Lifecycle:** the first-run capability flips between three high-level
 * states — `pending`, `in_progress`, `complete`. The provider surfaces an
 * affordance only when state is `pending` or `in_progress`. When the user
 * abandons mid-customize, state stays `in_progress` and `partialAnswers`
 * holds the answers collected so far so the next invocation resumes.
 *
 * **OwnerFactStore wrapper:** Wave-1 ships an interim `OwnerFactStore` that
 * is a thin facade over the existing `LifeOpsOwnerProfile` (per
 * `IMPLEMENTATION_PLAN.md` §3.3 "OwnerFactStore stub"). The interface is the
 * eventual W2-E shape — `read` / `update` of the well-known facts the
 * first-run flow touches. Wave-2 W2-E swaps the implementation in place;
 * call sites do not change.
 *
 * **Fact set this wave touches:** `preferredName`, `timezone`,
 * `morningWindow`, `eveningWindow`, `preferredNotificationChannel`, `locale`.
 *
 * Source of truth for the contract: `wave1-interfaces.md` §4.1 / §8 +
 * `GAP_ASSESSMENT.md` §3.10 / §5.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  readLifeOpsOwnerProfile,
  updateLifeOpsOwnerProfile,
} from "../owner-profile.js";

// --- OwnerFactStore (interim wrapper) -------------------------------------

export interface OwnerFactWindow {
  /** "HH:MM" 24h. Local to `timezone`. */
  startLocal: string;
  /** "HH:MM" 24h. Local to `timezone`. */
  endLocal: string;
}

export interface OwnerFacts {
  preferredName?: string;
  timezone?: string;
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
  preferredNotificationChannel?: string;
  locale?: string;
  /** ISO-8601 of last update; null when never written. */
  updatedAt: string | null;
}

export interface OwnerFactsPatch {
  preferredName?: string;
  timezone?: string;
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
  preferredNotificationChannel?: string;
  locale?: string;
}

export interface OwnerFactStore {
  read(): Promise<OwnerFacts>;
  update(patch: OwnerFactsPatch): Promise<OwnerFacts>;
}

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isWindow(value: unknown): value is OwnerFactWindow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.startLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(v.startLocal) &&
    typeof v.endLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(v.endLocal)
  );
}

function readWindowFromMetadata(
  metadata: Record<string, unknown> | null,
  key: string,
): OwnerFactWindow | undefined {
  if (!metadata) return undefined;
  const candidate = metadata[key];
  return isWindow(candidate) ? candidate : undefined;
}

/**
 * Concrete interim wrapper. Reads/writes through `LifeOpsOwnerProfile` for
 * the legacy fields and stores wave-1-specific extensions
 * (`morningWindow`, `eveningWindow`, `preferredNotificationChannel`, `locale`)
 * inside the same task metadata under the `ownerFactsExtensions` key. The
 * extension key is intentionally separate from `ownerProfile` so the legacy
 * path keeps its narrow string-only schema and the W2-E migration can move
 * the extensions cleanly.
 */
export function createOwnerFactStore(runtime: IAgentRuntime): OwnerFactStore {
  return {
    async read(): Promise<OwnerFacts> {
      const profile = await readLifeOpsOwnerProfile(runtime);
      const extensions = await readOwnerFactsExtensions(runtime);
      const facts: OwnerFacts = {
        updatedAt: profile.updatedAt,
      };
      if (profile.name && profile.name !== "admin") {
        facts.preferredName = profile.name;
      }
      if (extensions.timezone) {
        facts.timezone = extensions.timezone;
      }
      if (extensions.morningWindow) {
        facts.morningWindow = extensions.morningWindow;
      }
      if (extensions.eveningWindow) {
        facts.eveningWindow = extensions.eveningWindow;
      }
      if (extensions.preferredNotificationChannel) {
        facts.preferredNotificationChannel =
          extensions.preferredNotificationChannel;
      }
      if (extensions.locale) {
        facts.locale = extensions.locale;
      }
      return facts;
    },
    async update(patch: OwnerFactsPatch): Promise<OwnerFacts> {
      // Touch the legacy LifeOpsOwnerProfile when `preferredName` is in the
      // patch so existing readers stay consistent.
      if (typeof patch.preferredName === "string") {
        await updateLifeOpsOwnerProfile(runtime, {
          name: patch.preferredName,
        });
      }
      await mergeOwnerFactsExtensions(runtime, patch);
      return await this.read();
    },
  };
}

// --- Extensions storage (cache-backed, swap target for W2-E) -------------

const OWNER_FACTS_EXTENSIONS_CACHE_KEY =
  "eliza:lifeops:owner-facts-extensions:v1";

interface OwnerFactsExtensions {
  timezone?: string;
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
  preferredNotificationChannel?: string;
  locale?: string;
}

interface RuntimeCacheLike {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | undefined>;
  deleteCache?(key: string): Promise<boolean | undefined>;
}

function asCacheRuntime(runtime: IAgentRuntime): RuntimeCacheLike {
  const candidate = runtime as unknown as Partial<RuntimeCacheLike>;
  if (
    typeof candidate.getCache !== "function" ||
    typeof candidate.setCache !== "function"
  ) {
    throw new Error(
      "[first-run-state] runtime does not expose getCache/setCache",
    );
  }
  return candidate as RuntimeCacheLike;
}

async function readOwnerFactsExtensions(
  runtime: IAgentRuntime,
): Promise<OwnerFactsExtensions> {
  const cache = asCacheRuntime(runtime);
  const stored = await cache.getCache<Record<string, unknown>>(
    OWNER_FACTS_EXTENSIONS_CACHE_KEY,
  );
  if (!stored || typeof stored !== "object") return {};
  const ext: OwnerFactsExtensions = {};
  if (typeof stored.timezone === "string" && stored.timezone) {
    ext.timezone = stored.timezone;
  }
  const morning = readWindowFromMetadata(stored, "morningWindow");
  if (morning) ext.morningWindow = morning;
  const evening = readWindowFromMetadata(stored, "eveningWindow");
  if (evening) ext.eveningWindow = evening;
  if (
    typeof stored.preferredNotificationChannel === "string" &&
    stored.preferredNotificationChannel
  ) {
    ext.preferredNotificationChannel = stored.preferredNotificationChannel;
  }
  if (typeof stored.locale === "string" && stored.locale) {
    ext.locale = stored.locale;
  }
  return ext;
}

async function mergeOwnerFactsExtensions(
  runtime: IAgentRuntime,
  patch: OwnerFactsPatch,
): Promise<void> {
  const cache = asCacheRuntime(runtime);
  const current = await readOwnerFactsExtensions(runtime);
  const next: OwnerFactsExtensions = { ...current };
  if (typeof patch.timezone === "string") {
    next.timezone = patch.timezone;
  }
  if (patch.morningWindow && isWindow(patch.morningWindow)) {
    next.morningWindow = patch.morningWindow;
  }
  if (patch.eveningWindow && isWindow(patch.eveningWindow)) {
    next.eveningWindow = patch.eveningWindow;
  }
  if (typeof patch.preferredNotificationChannel === "string") {
    next.preferredNotificationChannel = patch.preferredNotificationChannel;
  }
  if (typeof patch.locale === "string") {
    next.locale = patch.locale;
  }
  await cache.setCache(OWNER_FACTS_EXTENSIONS_CACHE_KEY, next);
}

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
  /** Reset the lifecycle entirely (LIFEOPS.wipe + replay re-entry). */
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
