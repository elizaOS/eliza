/**
 * Home-attention store (#9143).
 *
 * Data-driven home widgets (calendar, goals, finances, health, …) carry their
 * urgency in their *own* fetched data — an overdrawn balance, an at-risk goal,
 * an event starting in 10 minutes — not in the shared activity-event or
 * notification streams the home ranker reads. This store is the seam that lets
 * such a widget feed its current importance back to the ranker: the widget
 * publishes a weight while the attention-worthy condition holds and clears it
 * otherwise; {@link WidgetHost} merges these into `rankHomeWidgets` so the
 * widget floats up by *its own* state.
 *
 * Unlike activity/notification signals, a self-published weight represents a
 * *sustained state* (the balance is still negative), so it must NOT decay —
 * the store holds only `widgetKey → weight` and the consumer stamps `now` at
 * read time (age 0 ⇒ full weight) until the widget clears it.
 */

import { useEffect, useSyncExternalStore } from "react";

/** A widget's current self-reported home importance (no timestamp — see file doc). */
export interface HomeAttentionEntry {
  /** `${pluginId}/${id}` of the publishing widget. */
  widgetKey: string;
  /** Sustained importance weight (higher = more urgent). */
  weight: number;
}

let entries: Record<string, number> = {};
let snapshot: HomeAttentionEntry[] = [];
const listeners = new Set<() => void>();

function recompute(): void {
  snapshot = Object.entries(entries).map(([widgetKey, weight]) => ({
    widgetKey,
    weight,
  }));
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publish (or update) a widget's sustained home-attention weight. */
export function publishHomeAttention(widgetKey: string, weight: number): void {
  if (entries[widgetKey] === weight) return;
  entries = { ...entries, [widgetKey]: weight };
  recompute();
  emit();
}

/** Clear a widget's home-attention (the condition no longer holds / unmounted). */
export function clearHomeAttention(widgetKey: string): void {
  if (!(widgetKey in entries)) return;
  const next = { ...entries };
  delete next[widgetKey];
  entries = next;
  recompute();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): HomeAttentionEntry[] {
  return snapshot;
}

/** Reactive view of every widget's current self-reported home attention. */
export function useHomeAttentionSignals(): HomeAttentionEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Widget-side helper: publish `weight` while it's a positive number, clear it
 * when `null`/`0`, and always clear on unmount. A widget computes its weight
 * from its fetched data (e.g. overdrawn → escalation weight) and passes it in;
 * passing `null` (no attention-worthy state) removes any prior boost.
 */
export function usePublishHomeAttention(
  widgetKey: string,
  weight: number | null,
): void {
  useEffect(() => {
    if (weight == null || weight <= 0) {
      clearHomeAttention(widgetKey);
      return;
    }
    publishHomeAttention(widgetKey, weight);
    return () => clearHomeAttention(widgetKey);
  }, [widgetKey, weight]);
}

/** Test-only reset. */
export function __resetHomeAttentionForTests(): void {
  entries = {};
  snapshot = [];
  listeners.clear();
}
