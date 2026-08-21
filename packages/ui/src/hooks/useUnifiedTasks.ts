/**
 * useUnifiedTasks — fetches automations (`GET /api/automations`) and LifeOps
 * scheduled tasks (`GET /api/lifeops/scheduled-tasks`) in parallel and merges
 * them into one `AutomationItem[]` via the pure `mergeUnifiedTasks` reader.
 *
 * This is a client-side read merge only — no backend store is touched, no
 * second scheduler is introduced. Either source degrading (404 where the
 * runtime/runner isn't hosted, e.g. mobile) is treated as empty, mirroring the
 * existing self-hide behaviour of the automations surfaces.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import type { AutomationListResponse } from "../api/client-types-config";
import type { ScheduledTaskListResponse } from "../api/client-types-core";
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

const DEFAULT_TIMEOUT_MS = 6_000;

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
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerVisibleOnly = options?.ownerVisibleOnly ?? true;
  const [state, setState] = useState<UnifiedTasksState>(INITIAL_STATE);
  const activeRequestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const { signal } = controller;
    try {
      const [automations, scheduled] = await Promise.all([
        settle(
          client.listAutomations({ timeoutMs, signal }),
          EMPTY_AUTOMATIONS,
        ),
        settle(
          client.listScheduledTasks(
            { ownerVisibleOnly },
            { timeoutMs, signal },
          ),
          EMPTY_SCHEDULED,
        ),
      ]);
      if (signal.aborted) return;
      const items = mergeUnifiedTasks(
        Array.isArray(automations.automations) ? automations.automations : [],
        Array.isArray(scheduled.tasks) ? scheduled.tasks : [],
      );
      setState({ items, automations, loading: false, error: null });
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
    }
  }, [timeoutMs, ownerVisibleOnly]);

  useEffect(() => {
    void load();
    return () => {
      activeRequestRef.current?.abort();
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  return { state, refresh };
}
