/**
 * `GlobalPauseStore` — vacation / pause mode singleton.
 *
 * Frozen interface from `docs/audit/wave1-interfaces.md` §4.5 +
 * `GAP_ASSESSMENT.md` §3.15.
 *
 * Only ONE pause window can be active at a time. The W1-A runner consults
 * `current()` pre-fire; tasks with `respectsGlobalPause: true` skip with
 * reason `global_pause`; tasks with `respectsGlobalPause: false` (emergencies)
 * fire anyway. If `endIso` is set on the active window, the runner reschedules
 * skipped tasks for `endIso` (the user's "resume my routine" moment).
 *
 * Backing storage: runtime cache. Single canonical key.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";

export interface GlobalPauseWindow {
  startIso: string;
  endIso?: string;
  reason?: string;
}

export interface GlobalPauseStatus {
  active: boolean;
  startIso?: string;
  endIso?: string;
  reason?: string;
}

export interface GlobalPauseStore {
  set(window: GlobalPauseWindow): Promise<void>;
  clear(): Promise<void>;
  current(now?: Date): Promise<GlobalPauseStatus>;
}

export const GLOBAL_PAUSE_CACHE_KEY = "eliza:lifeops:global-pause:v1";

function isValidIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function normalizeWindow(window: GlobalPauseWindow): GlobalPauseWindow {
  if (!isValidIso(window.startIso)) {
    throw new Error(
      `[global-pause] invalid startIso: ${String(window.startIso)}`,
    );
  }
  if (window.endIso !== undefined && !isValidIso(window.endIso)) {
    throw new Error(`[global-pause] invalid endIso: ${String(window.endIso)}`);
  }
  if (
    window.endIso !== undefined &&
    Date.parse(window.endIso) <= Date.parse(window.startIso)
  ) {
    throw new Error("[global-pause] endIso must be strictly after startIso");
  }
  const normalized: GlobalPauseWindow = { startIso: window.startIso };
  if (window.endIso !== undefined) {
    normalized.endIso = window.endIso;
  }
  if (typeof window.reason === "string" && window.reason.trim().length > 0) {
    normalized.reason = window.reason.trim().slice(0, 200);
  }
  return normalized;
}

function isWindowActive(window: GlobalPauseWindow, now: Date): boolean {
  const startMs = Date.parse(window.startIso);
  if (!Number.isFinite(startMs) || now.getTime() < startMs) {
    return false;
  }
  if (window.endIso === undefined) {
    return true;
  }
  const endMs = Date.parse(window.endIso);
  return Number.isFinite(endMs) && now.getTime() < endMs;
}

export function createGlobalPauseStore(
  runtime: IAgentRuntime,
): GlobalPauseStore {
  const cache = asCacheRuntime(runtime);

  return {
    async set(window: GlobalPauseWindow): Promise<void> {
      const normalized = normalizeWindow(window);
      await cache.setCache<GlobalPauseWindow>(
        GLOBAL_PAUSE_CACHE_KEY,
        normalized,
      );
    },
    async clear(): Promise<void> {
      await cache.deleteCache(GLOBAL_PAUSE_CACHE_KEY);
    },
    async current(now: Date = new Date()): Promise<GlobalPauseStatus> {
      const stored = await cache.getCache<GlobalPauseWindow | null>(
        GLOBAL_PAUSE_CACHE_KEY,
      );
      if (!stored || typeof stored !== "object") {
        return { active: false };
      }
      if (!isValidIso(stored.startIso)) {
        return { active: false };
      }
      const active = isWindowActive(stored, now);
      const status: GlobalPauseStatus = {
        active,
        startIso: stored.startIso,
      };
      if (stored.endIso !== undefined) {
        status.endIso = stored.endIso;
      }
      if (stored.reason !== undefined) {
        status.reason = stored.reason;
      }
      return status;
    },
  };
}
