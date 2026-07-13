/**
 * Cross-window "active chat host" truth for the desktop shell (#16200 Stage 3).
 *
 * The singular chat must render in exactly ONE window at a time — the focused
 * Eliza surface window, or the main floating-pill/dashboard window when no
 * surface is focused. The shell owns focus truth (the macOS focus poller and
 * per-window focus events feed it here); this module resolves which window is
 * the host and pushes `desktopActiveChatHostChanged` to every registered
 * renderer so each one can decide whether to mount the chat.
 *
 * Window ids are the electrobun numeric window id (`BrowserWindow.id`), which
 * is exactly what the preload injects as `window.__electrobunWindowId` — so a
 * renderer can compare a broadcast `hostWindowId` against its own id directly.
 */
import { logger } from "./logger";
import type { SendToWebview } from "./types.js";

/** Push-event name mirrored in rpc-schema.ts (`desktop:activeChatHostChanged`). */
export const ACTIVE_CHAT_HOST_MESSAGE = "desktopActiveChatHostChanged";

export interface ActiveChatHostInputs {
  /** The fallback host: the floating pill / main dashboard window. */
  mainWindowId: number | null;
  /** The surface window that currently holds focus, or null when none does. */
  focusedSurfaceWindowId: number | null;
  /**
   * Whether the focused surface window actually renders the chat (its
   * surface/tab === "chat"). Only the detached chat window can take the host;
   * a focused documents/character/etc. surface renders no chat surface, so it
   * must NOT become the host — that would hide the pill and vanish the chat.
   */
  focusedSurfaceIsChatCapable: boolean;
  /** Whether the Eliza app is frontmost (another app frontmost => inactive). */
  appActive: boolean;
}

/**
 * A focused surface window hosts the chat only when it renders the chat AND the
 * app is frontmost; otherwise the main window (pill / dashboard) is the host.
 * That covers all the fallbacks in one expression: the pill is host when the
 * pill is focused, when no surface is focused, when the focused surface is not
 * the chat window, and when another app is frontmost.
 */
export function resolveActiveChatHostWindowId(
  inputs: ActiveChatHostInputs,
): number | null {
  const {
    mainWindowId,
    focusedSurfaceWindowId,
    focusedSurfaceIsChatCapable,
    appActive,
  } = inputs;
  if (
    focusedSurfaceWindowId !== null &&
    focusedSurfaceIsChatCapable &&
    appActive
  ) {
    return focusedSurfaceWindowId;
  }
  return mainWindowId;
}

/**
 * Holds the per-window renderer push channels plus the focus/app-active inputs,
 * and fans out host changes. Broadcasts land on a change only; a late-joining
 * renderer catches up via `sendCurrentHostToWindow` on its dom-ready.
 */
export class ActiveChatHostBroadcaster {
  private readonly sends = new Map<number, SendToWebview>();
  // The subset of registered surface windows that render the chat (surface
  // "chat"). Only these may take the host from the main window.
  private readonly chatCapableSurfaces = new Set<number>();
  private mainWindowId: number | null = null;
  private focusedSurfaceWindowId: number | null = null;
  // Default active: only the macOS focus poller can observe app-level
  // deactivation, so on Win/Linux the app is always treated as active and host
  // truth comes purely from per-window focus events.
  private appActive = true;
  private lastBroadcastHostId: number | null = null;

  /**
   * Add a surface window to the broadcast set. `chatCapable` is true only for
   * the detached chat window (surface "chat"); a non-chat surface joins the
   * broadcast set (so it can be told the host) but can never become the host.
   */
  registerWindow(
    windowId: number,
    send: SendToWebview,
    chatCapable = false,
  ): void {
    this.sends.set(windowId, send);
    if (chatCapable) {
      this.chatCapableSurfaces.add(windowId);
    } else {
      this.chatCapableSurfaces.delete(windowId);
    }
  }

  /**
   * Declare the fallback host and add it to the broadcast set. A pill<->dashboard
   * swap mints a new window id, so the previous main is dropped to avoid pushing
   * to a dead webview.
   */
  setMainWindow(windowId: number, send: SendToWebview): void {
    if (this.mainWindowId !== null && this.mainWindowId !== windowId) {
      this.sends.delete(this.mainWindowId);
    }
    this.mainWindowId = windowId;
    this.sends.set(windowId, send);
  }

  /** Drop a window from the broadcast set; clears any focus/main role it held. */
  unregisterWindow(windowId: number): void {
    this.sends.delete(windowId);
    this.chatCapableSurfaces.delete(windowId);
    if (this.focusedSurfaceWindowId === windowId) {
      this.focusedSurfaceWindowId = null;
    }
    if (this.mainWindowId === windowId) {
      this.mainWindowId = null;
    }
  }

  /**
   * A surface window gained focus. It only wins the host if it is the chat
   * window (the resolver gates on chat-capability), so recording a focused
   * non-chat surface here still leaves the host at the main window.
   */
  setFocusedSurface(windowId: number): void {
    this.focusedSurfaceWindowId = windowId;
  }

  /** The main window is the key window, so no surface holds focus. */
  clearFocusedSurface(): void {
    this.focusedSurfaceWindowId = null;
  }

  /** Frontmost-app state; only the macOS poller drives this away from true. */
  setAppActive(active: boolean): void {
    this.appActive = active;
  }

  getActiveChatHostWindowId(): number | null {
    return resolveActiveChatHostWindowId({
      mainWindowId: this.mainWindowId,
      focusedSurfaceWindowId: this.focusedSurfaceWindowId,
      focusedSurfaceIsChatCapable:
        this.focusedSurfaceWindowId !== null &&
        this.chatCapableSurfaces.has(this.focusedSurfaceWindowId),
      appActive: this.appActive,
    });
  }

  /**
   * Push the current host to a single window. Used on a renderer's dom-ready so
   * a window that joined (or reloaded) after the last change still learns who
   * hosts the chat. Does not touch the change-dedup state.
   */
  sendCurrentHostToWindow(windowId: number): void {
    const send = this.sends.get(windowId);
    if (!send) return;
    const hostWindowId = this.getActiveChatHostWindowId();
    if (hostWindowId === null) return;
    send(ACTIVE_CHAT_HOST_MESSAGE, { hostWindowId });
  }

  /**
   * Recompute the host and, only when it changed since the last broadcast, push
   * `desktopActiveChatHostChanged` to every registered window.
   */
  broadcastActiveChatHost(): void {
    const hostWindowId = this.getActiveChatHostWindowId();
    if (hostWindowId === null || hostWindowId === this.lastBroadcastHostId) {
      return;
    }
    this.lastBroadcastHostId = hostWindowId;
    logger.debug(`[ActiveChatHost] host -> window ${hostWindowId}`);
    for (const send of this.sends.values()) {
      send(ACTIVE_CHAT_HOST_MESSAGE, { hostWindowId });
    }
  }
}

let broadcaster: ActiveChatHostBroadcaster | null = null;

export function getActiveChatHostBroadcaster(): ActiveChatHostBroadcaster {
  broadcaster ??= new ActiveChatHostBroadcaster();
  return broadcaster;
}
