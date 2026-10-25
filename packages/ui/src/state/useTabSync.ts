/**
 * Cross-window (same-origin) sync via BroadcastChannel.
 *
 * Opening the app in two browser windows/tabs of the same origin keeps the
 * active conversation (and a small set of UI prefs) in sync, so switching
 * conversations in one window reflects in the others without a round-trip to
 * the server. Each window still owns its own per-connection server state; this
 * only mirrors UI selection between windows of the *same* browser.
 *
 * Environments without BroadcastChannel (older webviews, SSR, some native
 * shells) get an inert `publish*` surface and never receive callbacks.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

const TAB_SYNC_CHANNEL = "elizaos-tab-sync";

/** UI preferences mirrored across windows. Extend as new prefs need syncing. */
export interface TabSyncPrefs {
  language?: string;
}

type TabSyncMessage =
  | { kind: "active-conversation"; conversationId: string | null }
  | { kind: "prefs"; prefs: TabSyncPrefs };

export interface UseTabSyncOptions {
  /** Called when another window changes its active conversation. */
  onActiveConversation?: (conversationId: string | null) => void;
  /** Called when another window updates synced UI prefs. */
  onPrefs?: (prefs: TabSyncPrefs) => void;
}

export interface TabSyncApi {
  /** Broadcast this window's active conversation to the other windows. */
  publishActiveConversation: (conversationId: string | null) => void;
  /** Broadcast updated UI prefs to the other windows. */
  publishPrefs: (prefs: TabSyncPrefs) => void;
  /** True when BroadcastChannel is available and wired up. */
  enabled: boolean;
}

function isTabSyncMessage(value: unknown): value is TabSyncMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "active-conversation") {
    const id = (value as { conversationId?: unknown }).conversationId;
    return id === null || typeof id === "string";
  }
  if (kind === "prefs") {
    const prefs = (value as { prefs?: unknown }).prefs;
    return typeof prefs === "object" && prefs !== null;
  }
  return false;
}

const NOOP_API: TabSyncApi = {
  publishActiveConversation: () => {},
  publishPrefs: () => {},
  enabled: false,
};

export function useTabSync(options: UseTabSyncOptions = {}): TabSyncApi {
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Keep callbacks in a ref so the channel subscription is set up once and
  // never resubscribes when the parent re-renders with new handler identities.
  const handlersRef = useRef<UseTabSyncOptions>(options);
  handlersRef.current = options;

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(TAB_SYNC_CHANNEL);
    channelRef.current = channel;

    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (!isTabSyncMessage(data)) return;
      if (data.kind === "active-conversation") {
        handlersRef.current.onActiveConversation?.(data.conversationId);
      } else {
        handlersRef.current.onPrefs?.(data.prefs);
      }
    };

    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
      channelRef.current = null;
    };
    // Intentionally empty deps: subscribe once; handlers are read via the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publishActiveConversation = useCallback(
    (conversationId: string | null): void => {
      channelRef.current?.postMessage({
        kind: "active-conversation",
        conversationId,
      } satisfies TabSyncMessage);
    },
    [],
  );

  const publishPrefs = useCallback((prefs: TabSyncPrefs): void => {
    channelRef.current?.postMessage({
      kind: "prefs",
      prefs,
    } satisfies TabSyncMessage);
  }, []);

  const enabled = typeof BroadcastChannel !== "undefined";

  // Return a stable object so consumers can list this in effect/callback deps
  // without re-running on every render.
  return useMemo<TabSyncApi>(
    () =>
      enabled ? { publishActiveConversation, publishPrefs, enabled } : NOOP_API,
    [enabled, publishActiveConversation, publishPrefs],
  );
}
