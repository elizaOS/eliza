/**
 * Home-widget dismissal / "seen" store (#9959).
 *
 * The data-driven home widgets bubble up by urgency and self-hide when empty,
 * but nothing could show *once* and then permanently retire after the user
 * acted — so transient guidance (for example, connector nudges) had no graceful fade and was ripped out wholesale. This store is that
 * missing primitive: it persists a per-widget lifecycle (`seen` sessions,
 * `acted`, `dismissed`) keyed by `homeWidgetKey`, and {@link isHomeWidgetSunset}
 * turns a widget's declared {@link HomeWidgetSunset} policy into a retire
 * decision. {@link WidgetHost} filters sunset widgets out of the home slot.
 *
 * Mirrors `home-attention-store.ts` (external store + `useSyncExternalStore`),
 * adding `localStorage` persistence so a retired card stays retired across
 * reloads.
 */

import { useEffect, useSyncExternalStore } from "react";
import type { HomeWidgetSunset } from "./types";

const STORAGE_KEY = "eliza:home-dismissed:v1";

/** Persisted per-widget lifecycle. */
export interface HomeWidgetLifecycle {
  /** Distinct sessions the widget has been shown in. */
  seen: number;
  /** The user acted on the widget (tapped a chip / followed its CTA). */
  acted: boolean;
  /** The user explicitly dismissed the widget. */
  dismissed: boolean;
}

const BLANK: HomeWidgetLifecycle = { seen: 0, acted: false, dismissed: false };

function readPersisted(): Record<string, HomeWidgetLifecycle> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, HomeWidgetLifecycle> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Partial<HomeWidgetLifecycle>;
      out[key] = {
        seen: typeof v.seen === "number" && v.seen > 0 ? Math.floor(v.seen) : 0,
        acted: v.acted === true,
        dismissed: v.dismissed === true,
      };
    }
    return out;
  } catch {
    // error-policy:J3 corrupt/partial persisted value is untrusted input; start
    // clean rather than wedge the home. Absence and corruption both render empty
    // here by design — there is no data to surface.
    return {};
  }
}

let state: Record<string, HomeWidgetLifecycle> = readPersisted();
const listeners = new Set<() => void>();
// One increment of `seen` per app session per key: re-mounting the widget while
// navigating must not inflate the count toward an `afterSeen` retirement.
const seenThisSession = new Set<string>();

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full / disabled — the in-memory state still drives this session.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function mutate(
  key: string,
  fn: (prev: HomeWidgetLifecycle) => HomeWidgetLifecycle,
): void {
  const prev = state[key] ?? BLANK;
  const next = fn(prev);
  if (
    next.seen === prev.seen &&
    next.acted === prev.acted &&
    next.dismissed === prev.dismissed
  ) {
    return;
  }
  state = { ...state, [key]: next };
  persist();
  emit();
}

/** Count one session-view of a widget (idempotent within a session). */
export function recordHomeWidgetSeen(key: string): void {
  if (seenThisSession.has(key)) return;
  seenThisSession.add(key);
  mutate(key, (prev) => ({ ...prev, seen: prev.seen + 1 }));
}

/** Mark that the user acted on the widget (taps a chip, follows its CTA). */
export function markHomeWidgetActed(key: string): void {
  mutate(key, (prev) => ({ ...prev, acted: true }));
}

/** Mark that the user explicitly dismissed the widget. */
export function dismissHomeWidget(key: string): void {
  mutate(key, (prev) => ({ ...prev, dismissed: true }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Record<string, HomeWidgetLifecycle> {
  return state;
}

/** Reactive view of every home widget's persisted lifecycle. */
export function useHomeDismissals(): Record<string, HomeWidgetLifecycle> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Record one session-view on mount; safe to call from any sunset-able widget. */
export function useRecordHomeWidgetSeen(key: string, enabled = true): void {
  useEffect(() => {
    if (enabled) recordHomeWidgetSeen(key);
  }, [key, enabled]);
}

/**
 * Decide whether a sunset-able widget should now be retired from the home grid.
 * Pure — the live lifecycle map flows in from {@link useHomeDismissals}. A widget
 * with no `sunset` policy never retires here.
 */
export function isHomeWidgetSunset(
  key: string,
  sunset: HomeWidgetSunset | undefined,
  dismissals: Record<string, HomeWidgetLifecycle>,
): boolean {
  if (!sunset) return false;
  const life = dismissals[key] ?? BLANK;
  if (sunset.dismissible && life.dismissed) return true;
  if (sunset.afterAction && life.acted) return true;
  if (
    typeof sunset.afterSeen === "number" &&
    sunset.afterSeen > 0 &&
    life.seen > sunset.afterSeen
  ) {
    return true;
  }
  return false;
}

/** Test-only reset (state + session guard + listeners). */
export function __resetHomeDismissalsForTests(): void {
  state = {};
  seenThisSession.clear();
  listeners.clear();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
