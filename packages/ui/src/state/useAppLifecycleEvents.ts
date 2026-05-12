/**
 * Wires Capacitor app lifecycle events to runtime state.
 *
 * The native shell (`packages/app/src/main.tsx`) bridges
 * `CapacitorApp.appStateChange` into `APP_RESUME_EVENT` /
 * `APP_PAUSE_EVENT`. This hook is the renderer-side consumer:
 *
 *  - On `APP_PAUSE_EVENT`:
 *    abort any in-flight chat stream before iOS suspends the process and
 *    persist the active conversation id so the next foreground can restore
 *    it (the storage bridge mirrors the key to Capacitor Preferences, so
 *    the value survives a WKWebView localStorage purge under memory
 *    pressure).
 *
 *  - On `APP_RESUME_EVENT`:
 *    re-probe `/api/health` to detect that the FGS / dev server respawned
 *    on a new port, clean up the "last assistant turn was an empty
 *    streaming placeholder" anomaly (mark interrupted), and trigger any
 *    pending background-runner wake deliveries.
 */

import type { MutableRefObject } from "react";
import { useEffect } from "react";
import { type ConversationMessage, client } from "../api";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";

/** Storage key for the last-known active conversation id. */
export const ACTIVE_CONVERSATION_STORAGE_KEY =
  "eliza:chat:activeConversationId";

interface UseAppLifecycleEventsParams {
  activeConversationIdRef: MutableRefObject<string | null>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  chatAbortRef: MutableRefObject<AbortController | null>;
  setConversationMessages: (
    updater:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
}

interface HealthBody {
  ok?: unknown;
  ready?: unknown;
  agentState?: unknown;
}

function isHealthy(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as HealthBody;
  if (b.ok === true) return true;
  if (b.ready === true) return true;
  if (b.agentState === "running") return true;
  return false;
}

/**
 * Re-probe the agent's `/api/health`. Used on app resume so the renderer
 * notices when the FGS (Android) or native runtime came back up on a
 * different port than the boot config remembered.
 */
async function probeAgentHealth(): Promise<boolean> {
  try {
    const body = await client.fetch<unknown>("/api/health", undefined, {
      allowNonOk: true,
      timeoutMs: 5_000,
    });
    return isHealthy(body);
  } catch {
    return false;
  }
}

/**
 * Best-effort drain of pending background-runner deliveries.
 *
 * TODO(wave-3d): the `GET /api/internal/wake/pending` route does not exist
 * yet — only the `POST /api/internal/wake` writer is implemented in
 * `packages/app-core/src/api/internal-routes.ts`. Once the reader lands,
 * unblock this function to consume queued deliveries.
 */
async function drainPendingWakeDeliveries(): Promise<void> {
  /* TODO(wave-3d): consume queued wake deliveries when reader lands. */
}

export function useAppLifecycleEvents({
  activeConversationIdRef,
  conversationMessagesRef,
  chatAbortRef,
  setConversationMessages,
}: UseAppLifecycleEventsParams): void {
  // ── APP_PAUSE: gracefully abort in-flight streams before suspend ──
  useEffect(() => {
    const onPause = (): void => {
      const controller = chatAbortRef.current;
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      chatAbortRef.current = null;

      const activeId = activeConversationIdRef.current;
      if (typeof window !== "undefined") {
        try {
          if (activeId) {
            window.localStorage.setItem(
              ACTIVE_CONVERSATION_STORAGE_KEY,
              activeId,
            );
          } else {
            window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
          }
        } catch {
          // localStorage may throw under sandbox / quota; the storage
          // bridge already mirrors writes to Capacitor Preferences, so a
          // failure here is not fatal.
        }
      }
    };

    document.addEventListener(APP_PAUSE_EVENT, onPause);
    return () => {
      document.removeEventListener(APP_PAUSE_EVENT, onPause);
    };
  }, [activeConversationIdRef, chatAbortRef]);

  // ── APP_RESUME: re-probe health + sweep stale assistant placeholder ──
  useEffect(() => {
    const onResume = (): void => {
      void probeAgentHealth();

      const messages = conversationMessagesRef.current;
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      if (last && last.role === "assistant" && last.text === "") {
        setConversationMessages((prev) =>
          prev.map((message) =>
            message.id === last.id
              ? { ...message, interrupted: true }
              : message,
          ),
        );
      }

      void drainPendingWakeDeliveries();
    };

    document.addEventListener(APP_RESUME_EVENT, onResume);
    return () => {
      document.removeEventListener(APP_RESUME_EVENT, onResume);
    };
  }, [conversationMessagesRef, setConversationMessages]);
}
