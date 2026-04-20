/**
 * Trigger (heartbeat) state — extracted from AppContext.
 *
 * Manages trigger CRUD, run history, and health polling. Zero coupling to
 * the startup sequence — triggers are only loaded post-ready.
 */

import { useCallback, useState } from "react";
import type {
  CreateTriggerRequest,
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
  UpdateTriggerRequest,
} from "../api";
import { client } from "../api";

// ── Helpers ───────────────────────────────────────────────────────────

function sortTriggersByNextRun(items: TriggerSummary[]): TriggerSummary[] {
  return [...items].sort((a, b) => {
    const aNext = a.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    const bNext = b.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    if (aNext !== bNext) return aNext - bNext;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useTriggersState() {
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [triggersLoaded, setTriggersLoaded] = useState(false);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersSaving, setTriggersSaving] = useState(false);
  const [triggerRunsById, setTriggerRunsById] = useState<
    Record<string, TriggerRunRecord[]>
  >({});
  const [triggerHealth, setTriggerHealth] =
    useState<TriggerHealthSnapshot | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const loadTriggerHealth = useCallback(async () => {
    try {
      const health = await client.getTriggerHealth();
      setTriggerHealth(health);
    } catch {
      setTriggerHealth(null);
    }
  }, []);

  const loadTriggers = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setTriggersLoading(true);
    }
    try {
      const data = await client.getTriggers();
      setTriggers(sortTriggersByNextRun(data.triggers));
      setTriggerError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load triggers";
      setTriggerError(message);
      if (!silent) {
        setTriggers([]);
      }
    } finally {
      setTriggersLoaded(true);
      if (!silent) {
        setTriggersLoading(false);
      }
    }
  }, []);

  const ensureTriggersLoaded = useCallback(async () => {
    await loadTriggers(triggersLoaded ? { silent: true } : undefined);
  }, [loadTriggers, triggersLoaded]);

  const loadTriggerRuns = useCallback(async (id: string) => {
    try {
      const data = await client.getTriggerRuns(id);
      setTriggerRunsById((prev) => ({ ...prev, [id]: data.runs }));
      setTriggerError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load trigger runs";
      setTriggerError(message);
    }
  }, []);

  const createTrigger = useCallback(
    async (request: CreateTriggerRequest): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.createTrigger(request);
        const created = response.trigger;
        setTriggers((prev) => {
          const merged = prev.filter((item) => item.id !== created.id);
          merged.push(created);
          return sortTriggersByNextRun(merged);
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return created;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth],
  );

  const updateTrigger = useCallback(
    async (
      id: string,
      request: UpdateTriggerRequest,
    ): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.updateTrigger(id, request);
        const updated = response.trigger;
        setTriggers((prev) => {
          const merged = prev.map((item) =>
            item.id === updated.id ? updated : item,
          );
          return sortTriggersByNextRun(merged);
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return updated;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth],
  );

  const deleteTrigger = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        await client.deleteTrigger(id);
        setTriggers((prev) => prev.filter((item) => item.id !== id));
        setTriggerRunsById((prev) => {
          const next: Record<string, TriggerRunRecord[]> = {};
          for (const [key, runs] of Object.entries(prev)) {
            if (key !== id) next[key] = runs;
          }
          return next;
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth],
  );

  const runTriggerNow = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        const response = await client.runTriggerNow(id);
        if (response.trigger) {
          const trigger = response.trigger;
          setTriggers((prev) => {
            const idx = prev.findIndex((item) => item.id === id);
            if (idx === -1) {
              return sortTriggersByNextRun([...prev, trigger]);
            }
            const updated = [...prev];
            updated[idx] = trigger;
            return sortTriggersByNextRun(updated);
          });
        } else {
          await loadTriggers();
        }
        await loadTriggerRuns(id);
        void loadTriggerHealth();
        setTriggerError(null);
        return response.ok;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to run trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth, loadTriggerRuns, loadTriggers],
  );

  return {
    state: {
      triggers,
      triggersLoaded,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
    },
    loadTriggers,
    loadTriggerHealth,
    loadTriggerRuns,
    ensureTriggersLoaded,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    runTriggerNow,
  };
}
