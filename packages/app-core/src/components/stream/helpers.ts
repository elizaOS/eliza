/**
 * Shared helpers, constants, and types for StreamView sub-components.
 */

import type { StreamEventEnvelope } from "@miladyai/app-core/api";
import { invokeDesktopBridgeRequest } from "@miladyai/app-core/bridge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHAT_ACTIVE_WINDOW_MS = 30_000;
export const TERMINAL_ACTIVE_WINDOW_MS = 15_000;

/** PIP window dimensions (640x360 → captures at 1280x720 on Retina 2x displays). */
export const PIP_SIZE = { width: 640, height: 360 };
export const FULL_SIZE = { width: 1280, height: 720 };

export const CHANNEL_COLORS: Record<
  string,
  { border: string; bg: string; text: string }
> = {
  retake: {
    border: "border-fuchsia-500/30",
    bg: "bg-fuchsia-500/5",
    text: "text-fuchsia-400",
  },
  discord: {
    border: "border-indigo-500/30",
    bg: "bg-indigo-500/5",
    text: "text-indigo-400",
  },
};

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

export function getEventFrom(event: StreamEventEnvelope): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.displayName === "string" && payload.displayName.trim())
    return payload.displayName.trim();
  if (typeof payload.from === "string" && payload.from.trim())
    return payload.from.trim();
  return undefined;
}

export function getEventText(event: StreamEventEnvelope): string {
  const payload = event.payload as Record<string, unknown>;
  const text = payload.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  const preview = payload.preview;
  if (typeof preview === "string" && preview.trim()) return preview.trim();
  const reason = payload.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return event.stream ? `${event.stream} event` : event.type;
}

export function getEventSource(event: StreamEventEnvelope): string {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.source === "string") return payload.source;
  if (typeof payload.channel === "string") return payload.channel;
  return event.stream ?? "agent";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMode = "gaming" | "terminal" | "chatting" | "idle";

export type StreamSourceType = "stream-tab" | "game" | "custom-url";

export const STREAM_SOURCE_LABELS: Record<StreamSourceType, string> = {
  "stream-tab": "Stream Tab",
  game: "Game",
  "custom-url": "Custom URL",
};

export function isSupportedStreamUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Popout / Always-on-top
// ---------------------------------------------------------------------------

/** Detect popout mode from URL. */
export const IS_POPOUT = (() => {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  return params.has("popout");
})();

/** Toggle always-on-top for the current desktop window. */
export async function toggleAlwaysOnTop(pinned: boolean): Promise<boolean> {
  try {
    // Try Capacitor Desktop plugin
    const cap = (window as unknown as Record<string, unknown>).Capacitor as
      | Record<string, unknown>
      | undefined;
    if (cap?.Plugins) {
      const plugins = cap.Plugins as Record<string, unknown>;
      const desktop = plugins.Desktop as
        | { setAlwaysOnTop?: (opts: { flag: boolean }) => Promise<void> }
        | undefined;
      if (desktop?.setAlwaysOnTop) {
        await desktop.setAlwaysOnTop({ flag: pinned });
        return pinned;
      }
    }
    const result = await invokeDesktopBridgeRequest({
      rpcMethod: "desktopSetAlwaysOnTop",
      ipcChannel: "desktop:setAlwaysOnTop",
      params: { flag: pinned },
    });
    if (result !== null) {
      return pinned;
    }
  } catch {
    // Non-fatal — may not be running in the desktop shell
  }
  return false;
}
