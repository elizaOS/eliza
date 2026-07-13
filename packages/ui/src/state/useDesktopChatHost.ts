/**
 * Renderer half of the desktop "one chat, in the active window" coordinator
 * (#16200 Stage 3). Each Electrobun window is a separate webview/React tree, so
 * without coordination every window renders its own chat — the duplication the
 * floating pill + a focused view window produced. The shell owns focus truth
 * and broadcasts the active chat HOST window id via `desktopActiveChatHostChanged`;
 * each window renders the singular ChatOverlay only when it is that host. When
 * no other Eliza window is focused (or the app is inactive) the host is the main
 * floating-pill window, so the chat falls back to the bottom pill.
 *
 * Off the desktop shell (web / mobile / non-Electrobun) there is one window and
 * no host signal, so `useIsChatHostWindow` is always `true` — the chat renders
 * exactly as before.
 */
import { useSyncExternalStore } from "react";
import {
  getElectrobunWindowId,
  isElectrobunRuntime,
} from "../bridge/electrobun-runtime";
import { subscribeDesktopBridgeEvent } from "../bridge/electrobun-rpc";

interface ActiveChatHostPayload {
  hostWindowId?: number;
}

// Module-level so every hook consumer in this webview shares one subscription
// and one host value. `null` = no broadcast yet (default to showing so the main
// window's chat is never briefly blank at startup, before the shell's initial
// broadcast lands).
let hostWindowId: number | null = null;
let subscribed = false;
const listeners = new Set<() => void>();

function ensureSubscribed(): void {
  if (subscribed || !isElectrobunRuntime()) return;
  subscribed = true;
  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopActiveChatHostChanged",
    ipcChannel: "desktop:activeChatHostChanged",
    listener: (payload) => {
      const next = (payload as ActiveChatHostPayload | null | undefined)
        ?.hostWindowId;
      if (typeof next !== "number" || next === hostWindowId) return;
      hostWindowId = next;
      for (const listener of listeners) listener();
    },
  });
}

function subscribe(onStoreChange: () => void): () => void {
  ensureSubscribed();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Pure decision: does THIS window render the chat? `true` off the desktop shell
 * (one window). On desktop: `true` until the first host broadcast, then only
 * when this window IS the host. A window with no id (should not happen on the
 * desktop shell) defaults to showing rather than hiding the chat everywhere.
 */
export function resolveIsChatHost(
  host: number | null,
  myWindowId: number | null,
  isDesktop: boolean,
): boolean {
  if (!isDesktop) return true;
  if (host === null) return true;
  if (myWindowId === null) return true;
  return host === myWindowId;
}

/**
 * `true` when this window should render the singular ChatOverlay. Drives the
 * main-window overlay gate (and, once mounted there, the detached view windows).
 */
export function useIsChatHostWindow(): boolean {
  const host = useSyncExternalStore(
    subscribe,
    () => hostWindowId,
    () => hostWindowId,
  );
  return resolveIsChatHost(
    host,
    getElectrobunWindowId(),
    isElectrobunRuntime(),
  );
}

/** Test-only: reset the module-level host subscription state. */
export function __resetDesktopChatHostForTests(): void {
  hostWindowId = null;
  subscribed = false;
  listeners.clear();
}
