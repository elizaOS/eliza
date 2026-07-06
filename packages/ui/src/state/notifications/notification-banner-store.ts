/**
 * Transient banner queue for freshly-arrived notifications — the top-of-screen
 * "heads-up" surface (iOS/Android banner idiom). The notification store's
 * delivery path pushes an interruptive/focused arrival here; `NotificationBanners`
 * renders the live queue as glass cards that slide in from the top and auto-
 * dismiss. This is separate from the notification inbox (the persistent list on
 * the home) and from the shared `setActionNotice` toast (bottom, other surfaces):
 * a banner is the momentary alert, the inbox is the durable record.
 */
import type { AgentNotification } from "@elizaos/core";
import { useSyncExternalStore } from "react";

/** Newest-first cap: at most this many banners stack on screen at once. */
const MAX_BANNERS = 3;

let banners: readonly AgentNotification[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Queue a notification as a top banner. Newest first; a repeat of an id already
 * showing refreshes it in place (so a superseding same-id update doesn't stack a
 * duplicate). Trimmed to {@link MAX_BANNERS} — older banners drop off the bottom.
 */
export function pushNotificationBanner(notification: AgentNotification): void {
  const withoutDup = banners.filter((b) => b.id !== notification.id);
  banners = [notification, ...withoutDup].slice(0, MAX_BANNERS);
  emit();
}

/** Remove a banner (auto-dismiss timeout, tap-through, or explicit close). */
export function dismissNotificationBanner(id: string): void {
  const next = banners.filter((b) => b.id !== id);
  if (next.length === banners.length) return;
  banners = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly AgentNotification[] {
  return banners;
}

/** Subscribe to the live banner queue (newest first). */
export function useNotificationBanners(): readonly AgentNotification[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only reset. */
export function __resetNotificationBannersForTests(): void {
  banners = [];
  listeners.clear();
}
