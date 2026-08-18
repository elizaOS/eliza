/**
 * useUnifiedTasks — fetches automations (`GET /api/automations`) and LifeOps
 * scheduled tasks (`GET /api/lifeops/scheduled-tasks`) in parallel and merges
 * them into one `AutomationItem[]` via the pure `mergeUnifiedTasks` reader.
 *
 * This is a client-side read merge only — no backend store is touched, no
 * second scheduler is introduced. Either source degrading (404 where the
 * runtime/runner isn't hosted, e.g. mobile) is treated as empty, mirroring the
 * existing self-hide behaviour of the automations surfaces.
 *
 * Each hop goes through ElizaClient `fetch` with its own `{ timeoutMs }` so
 * Android/iOS `client.fetch` is actually bounded. Automations stay on
 * `workflowSurfaceClient` (mobile Cloud routing). Scheduled tasks stay on the
 * active client (plugin-scheduling is on-device).
 */

import { useCallback, useEffect, useState } from "react";
import { client } from "../api";
import type { AutomationListResponse } from "../api/client-types-config";
import type {
  ScheduledTaskListResponse,
  ScheduledTaskView,
} from "../api/client-types-core";
import { workflowSurfaceClient } from "../api/workflow-surface-routing";
import { mergeUnifiedTasks } from "../utils/merge-unified-tasks";

export interface UnifiedTasksState {
  items: ReturnType<typeof mergeUnifiedTasks>;
  /** The raw automations response (workflow status, summary, etc.). */
  automations: AutomationListResponse | null;
  /** True until the first fetch settles — distinguishes "loading" from "none". */
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: UnifiedTasksState = {
  items: [],
  automations: null,
  loading: true,
  error: null,
};

const EMPTY_AUTOMATIONS: AutomationListResponse = {
  automations: [],
  summary: {
    total: 0,
    coordinatorCount: 0,
    workflowCount: 0,
    scheduledCount: 0,
    draftCount: 0,
  },
  workflowStatus: null,
  workflowFetchError: null,
  executionFetchErrors: [],
};

const EMPTY_SCHEDULED: ScheduledTaskListResponse = { tasks: [] };

export interface UseUnifiedTasksOptions {
  /** Bound each bridge call so a hung channel settles the surface. */
  timeoutMs?: number;
  /** Restrict scheduled tasks to owner-visible rows. Default true. */
  ownerVisibleOnly?: boolean;
}

/** Automations list hop — existing 6s glance budget, independent of scheduled. */
export const UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS = 6_000;
/** Scheduled-tasks list hop — existing 6s glance budget, independent of automations. */
export const UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS = 6_000;

type UnifiedFetchClient = Pick<typeof client, "fetch">;

function scheduledTasksPath(ownerVisibleOnly: boolean): string {
  const params = new URLSearchParams();
  if (ownerVisibleOnly) params.set("ownerVisibleOnly", "1");
  const query = params.toString();
  return `/api/lifeops/scheduled-tasks${query ? `?${query}` : ""}`;
}

export async function fetchUnifiedAutomations(
  api: UnifiedFetchClient,
  timeoutMs: number = UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS,
): Promise<AutomationListResponse> {
  return api.fetch<AutomationListResponse>(
    "/api/automations",
    undefined,
    { timeoutMs },
  );
}

export async function fetchUnifiedScheduledTasks(
  api: UnifiedFetchClient,
  ownerVisibleOnly: boolean,
  timeoutMs: number = UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS,
): Promise<ScheduledTaskListResponse> {
  const res = await api.fetch<{ tasks?: ScheduledTaskView[] }>(
    scheduledTasksPath(ownerVisibleOnly),
    undefined,
    { timeoutMs },
  );
  return { tasks: Array.isArray(res?.tasks) ? res.tasks : [] };
}

async function settle<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    // Network/runtime failure (incl. 404 where the surface isn't hosted) —
    // settle to the empty fallback so the merge resolves rather than failing.
    return fallback;
  }
}

export function useUnifiedTasks(options?: UseUnifiedTasksOptions): {
  state: UnifiedTasksState;
  refresh: () => Promise<void>;
} {
  const automationsTimeoutMs =
    options?.timeoutMs ?? UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS;
  const scheduledTimeoutMs =
    options?.timeoutMs ?? UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS;
  const ownerVisibleOnly = options?.ownerVisibleOnly ?? true;
  const [state, setState] = useState<UnifiedTasksState>(INITIAL_STATE);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      const automationsClient = workflowSurfaceClient(client);
      const [automations, scheduled] = await Promise.all([
        settle(
          fetchUnifiedAutomations(automationsClient, automationsTimeoutMs),
          EMPTY_AUTOMATIONS,
        ),
        settle(
          fetchUnifiedScheduledTasks(
            client,
            ownerVisibleOnly,
            scheduledTimeoutMs,
          ),
          EMPTY_SCHEDULED,
        ),
      ]);
      if (signal.cancelled) return;
      const items = mergeUnifiedTasks(
        Array.isArray(automations.automations) ? automations.automations : [],
        Array.isArray(scheduled.tasks) ? scheduled.tasks : [],
      );
      setState({ items, automations, loading: false, error: null });
    },
    [automationsTimeoutMs, scheduledTimeoutMs, ownerVisibleOnly],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load({ cancelled: false });
  }, [load]);

  return { state, refresh };
}
