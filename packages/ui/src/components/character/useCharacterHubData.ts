/**
 * useCharacterHubData — consolidates the 5 read fetches that back the
 * CharacterHubView dashboard (history, experiences, relationship activity,
 * documents, learned curated skills).
 *
 * Each fetch is wrapped by `useFetchData` (so cancellation + error surfacing
 * are uniform) and projected into the simpler `{ data, loading, error,
 * refetch, mutate }` shape callers actually want. Local-storage cache hydration
 * + write-through stays here too — these are the same effects the hub used
 * to inline at module load.
 *
 * If you need to extend behaviour:
 *   - to invalidate a fetch from a write handler: `mutate(next)` for an
 *     optimistic update, or `refetch()` for a re-pull.
 *   - to add a new fetch: do it here, not back in the component, so the hub
 *     stays a section orchestrator.
 */

import { useCallback } from "react";
import { client } from "../../api/client";
import type {
  CharacterHistoryEntry,
  DocumentRecord,
  ExperienceRecord,
  RelationshipsActivityItem,
} from "../../api/client-types";
import { type FetchMutator, useFetchData } from "../../hooks/useFetchData";

export type LearnedSkillSummary = {
  description?: string | null;
  name: string;
  source?: string | null;
  status?: "active" | "proposed" | "disabled" | string;
};

type LearnedSkillsResponse = {
  skills?: LearnedSkillSummary[];
};

export type FetchSlice<T> = {
  data: T;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  mutate: FetchMutator<T>;
};

export interface CharacterHubData {
  documents: FetchSlice<DocumentRecord[]>;
  history: FetchSlice<CharacterHistoryEntry[]>;
  experiences: FetchSlice<ExperienceRecord[]>;
  relationshipActivity: FetchSlice<RelationshipsActivityItem[]>;
  learnedSkills: FetchSlice<LearnedSkillSummary[]>;
}

const HUB_CACHE_PREFIX = "character-hub-cache";

function hubCacheKey(suffix: string): string {
  return `${HUB_CACHE_PREFIX}:${suffix}`;
}

function readHubCache<T>(suffix: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(hubCacheKey(suffix));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeHubCache<T>(suffix: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(hubCacheKey(suffix), JSON.stringify(value));
  } catch {
    /* ignore quota / serialization errors */
  }
}

/**
 * Project a `useFetchData` discriminated-union result into a flat
 * `{ data, loading, error, refetch, mutate }` slice. `data` is seeded from
 * a local-storage cache so the dashboard renders populated content
 * immediately on remount; subsequent fetches overwrite it. A successful
 * fetch is also written back through `onSuccess` so the cache stays warm.
 */
function useFetchSlice<TRaw, TData>(
  cacheKey: string,
  fetcher: (signal: AbortSignal) => Promise<TRaw>,
  project: (raw: TRaw) => TData,
  initial: TData,
  onSuccess?: (projected: TData, raw: TRaw) => void,
): FetchSlice<TData> {
  const cached = readHubCache<TData>(cacheKey, initial);
  // Adapter wraps the fetcher to (a) project the response shape callers want
  // and (b) write through to the hub cache on success. Keeping side effects
  // inside the fetcher means they only run for a request that actually
  // completes (not for an aborted one).
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass stable fetch/project functions; cacheKey is the fetch identity.
  const adaptedFetcher = useCallback(
    async (signal: AbortSignal): Promise<TData> => {
      const raw = await fetcher(signal);
      const projected = project(raw);
      writeHubCache(cacheKey, projected);
      onSuccess?.(projected, raw);
      return projected;
    },
    // The dependency contract is intentional: callers pass a stable fetcher
    // (`client.x` methods are stable) and the projector/onSuccess capture
    // refs they care about. Re-creating the adapter on every render would
    // not retrigger the underlying effect (its dep list is the empty
    // tuple), so identity churn here is harmless.
    [cacheKey],
  );

  const result = useFetchData<TData>(adaptedFetcher, []);
  const data = result.status === "success" ? result.data : cached;

  // Wrap mutate so optimistic updates also write through to the cache and
  // can be called before the initial fetch has resolved. The bare
  // `result.mutate` throws when an updater fn runs against a non-success
  // state, which would surprise downstream callers (e.g. save/delete
  // handlers that fire while we are still loading on a cold mount).
  const baseMutate = result.mutate;
  const mutate = useCallback<FetchMutator<TData>>(
    (next: TData | ((prev: TData) => TData)) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: TData) => TData)(data)
          : next;
      writeHubCache(cacheKey, resolved);
      baseMutate(resolved);
    },
    [baseMutate, cacheKey, data],
  );

  return {
    data,
    loading: result.status === "loading",
    error: result.status === "error" ? result.error : null,
    refetch: result.refetch,
    mutate,
  };
}

export function useCharacterHubData(): CharacterHubData {
  const documents = useFetchSlice<
    { documents?: DocumentRecord[] },
    DocumentRecord[]
  >(
    "documents",
    () => client.listDocuments({ limit: 100 }),
    (response) => response.documents ?? [],
    [],
  );

  const history = useFetchSlice<
    { history: CharacterHistoryEntry[] },
    CharacterHistoryEntry[]
  >(
    "history",
    () => client.listCharacterHistory({ limit: 100 }),
    (response) => response.history,
    [],
  );

  const experiences = useFetchSlice<
    { experiences: ExperienceRecord[] },
    ExperienceRecord[]
  >(
    "experience-records",
    () => client.listExperiences({ limit: 100 }),
    (response) => response.experiences,
    [],
  );

  const relationshipActivity = useFetchSlice<
    { activity?: RelationshipsActivityItem[] },
    RelationshipsActivityItem[]
  >(
    "relationship-activity",
    () => client.getRelationshipsActivity(50),
    (response) => response.activity ?? [],
    [],
  );

  const learnedSkills = useFetchSlice<
    LearnedSkillsResponse,
    LearnedSkillSummary[]
  >(
    "learned-skills",
    () => client.fetch<LearnedSkillsResponse>("/api/skills/curated"),
    (data) => (data.skills ?? []).filter((skill) => skill.source !== "human"),
    [],
  );

  return {
    documents,
    history,
    experiences,
    relationshipActivity,
    learnedSkills,
  };
}
