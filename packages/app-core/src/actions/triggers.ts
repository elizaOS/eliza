/**
 * Trigger action helpers — extracted from AppContext.
 *
 * Pure functions for trigger CRUD operations that can be used
 * by any provider implementation.
 */

import type {
  CreateTriggerRequest,
  ElizaClient,
  TriggerRunRecord,
  TriggerSummary,
  UpdateTriggerRequest,
} from "../api/client";

export function sortTriggersByNextRun(
  items: TriggerSummary[],
): TriggerSummary[] {
  return [...items].sort((a, b) => {
    const aNext = a.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    const bNext = b.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    if (aNext !== bNext) return aNext - bNext;
    return a.displayName.localeCompare(b.displayName);
  });
}

export interface TriggerActionContext {
  client: ElizaClient;
  setTriggers: (fn: (prev: TriggerSummary[]) => TriggerSummary[]) => void;
  setTriggerRunsById: (
    fn: (
      prev: Record<string, TriggerRunRecord[]>,
    ) => Record<string, TriggerRunRecord[]>,
  ) => void;
  setTriggerError: (error: string | null) => void;
  setTriggersLoading: (loading: boolean) => void;
  setTriggersSaving: (saving: boolean) => void;
}

export async function loadTriggers(
  ctx: TriggerActionContext,
): Promise<TriggerSummary[]> {
  ctx.setTriggersLoading(true);
  try {
    const data = await ctx.client.getTriggers();
    const sorted = sortTriggersByNextRun(data.triggers);
    ctx.setTriggers(() => sorted);
    ctx.setTriggerError(null);
    return sorted;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load triggers";
    ctx.setTriggerError(message);
    ctx.setTriggers(() => []);
    return [];
  } finally {
    ctx.setTriggersLoading(false);
  }
}

export async function createTrigger(
  ctx: TriggerActionContext,
  request: CreateTriggerRequest,
): Promise<TriggerSummary | null> {
  ctx.setTriggersSaving(true);
  try {
    const response = await ctx.client.createTrigger(request);
    const created = response.trigger;
    ctx.setTriggers((prev) => {
      const merged = prev.filter((item) => item.id !== created.id);
      merged.push(created);
      return sortTriggersByNextRun(merged);
    });
    ctx.setTriggerError(null);
    return created;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create trigger";
    ctx.setTriggerError(message);
    return null;
  } finally {
    ctx.setTriggersSaving(false);
  }
}

export async function updateTrigger(
  ctx: TriggerActionContext,
  id: string,
  request: UpdateTriggerRequest,
): Promise<TriggerSummary | null> {
  ctx.setTriggersSaving(true);
  try {
    const response = await ctx.client.updateTrigger(id, request);
    const updated = response.trigger;
    ctx.setTriggers((prev) => {
      const merged = prev.map((item) =>
        item.id === updated.id ? updated : item,
      );
      return sortTriggersByNextRun(merged);
    });
    ctx.setTriggerError(null);
    return updated;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update trigger";
    ctx.setTriggerError(message);
    return null;
  } finally {
    ctx.setTriggersSaving(false);
  }
}

export async function deleteTrigger(
  ctx: TriggerActionContext,
  id: string,
): Promise<boolean> {
  ctx.setTriggersSaving(true);
  try {
    await ctx.client.deleteTrigger(id);
    ctx.setTriggers((prev) => prev.filter((item) => item.id !== id));
    ctx.setTriggerRunsById((prev) => {
      const next: Record<string, TriggerRunRecord[]> = {};
      for (const [key, runs] of Object.entries(prev)) {
        if (key !== id) next[key] = runs;
      }
      return next;
    });
    ctx.setTriggerError(null);
    return true;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete trigger";
    ctx.setTriggerError(message);
    return false;
  } finally {
    ctx.setTriggersSaving(false);
  }
}

export async function loadTriggerRuns(
  ctx: TriggerActionContext,
  id: string,
): Promise<void> {
  try {
    const data = await ctx.client.getTriggerRuns(id);
    ctx.setTriggerRunsById((prev) => ({
      ...prev,
      [id]: data.runs,
    }));
    ctx.setTriggerError(null);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load trigger runs";
    ctx.setTriggerError(message);
  }
}

export async function runTriggerNow(
  ctx: TriggerActionContext,
  id: string,
): Promise<boolean> {
  ctx.setTriggersSaving(true);
  try {
    const response = await ctx.client.runTriggerNow(id);
    if (response.trigger) {
      const trigger = response.trigger;
      ctx.setTriggers((prev) => {
        const idx = prev.findIndex((item) => item.id === id);
        if (idx === -1) {
          return sortTriggersByNextRun([...prev, trigger]);
        }
        const updated = [...prev];
        updated[idx] = trigger;
        return sortTriggersByNextRun(updated);
      });
    } else {
      await loadTriggers(ctx);
    }
    await loadTriggerRuns(ctx, id);
    ctx.setTriggerError(null);
    return response.ok;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to run trigger";
    ctx.setTriggerError(message);
    return false;
  } finally {
    ctx.setTriggersSaving(false);
  }
}
