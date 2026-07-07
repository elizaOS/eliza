/**
 * Wires app lifecycle events to runtime state on EVERY surface.
 *
 * The shell (`packages/app/src/main.tsx`) now bridges foreground/background
 * into `APP_RESUME_EVENT` / `APP_PAUSE_EVENT` on the installed **web** PWA too,
 * not only native Capacitor: `createMobileLifecycle` registers a
 * `document.visibilitychange` fallback unconditionally, so this hook's resume
 * path runs on the exact iOS PWA surface where a backgrounded app came back
 * with a dead WebSocket and a stale transcript (#PWA-D1/D2/D3).
 *
 *  - On `APP_PAUSE_EVENT`:
 *    abort any in-flight chat stream before iOS suspends the process and
 *    persist the active conversation id so the next foreground can restore
 *    it (the storage bridge mirrors the key to Capacitor Preferences, so
 *    the value survives a WKWebView localStorage purge under memory
 *    pressure).
 *
 *  - On `APP_RESUME_EVENT` (and on a persisted `pageshow` bfcache restore):
 *    re-probe `/api/health`, force a WebSocket reconnect / reset the reconnect
 *    backoff (so a socket iOS silently killed during suspension recovers
 *    immediately instead of waiting for the 30s background probe), and refetch
 *    the active conversation tail so agent messages missed while backgrounded
 *    appear \u2014 critical for dedicated-agent REST mode where there is no WS to
 *    reconnect and nothing else re-syncs. The stale empty-streaming-placeholder
 *    anomaly is still swept (mark interrupted). The whole resume sequence is
 *    debounced so rapid foreground/background flips (or a visibilitychange +
 *    bfcache pageshow arriving together) do not stampede reconnects/refetches.
 */

import type { MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import { type ConversationMessage, client } from "../api";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import type { LoadConversationMessagesResult } from "./internal";

/** Storage key for the last-known active conversation id. */
export const ACTIVE_CONVERSATION_STORAGE_KEY =
  "eliza:chat:activeConversationId";

/**
 * Coalesce window for the resume sequence. iOS can fire visibilitychange and a
 * bfcache `pageshow` back-to-back on a single foreground, and a user tabbing
 * quickly can flip background/foreground several times; debouncing collapses
 * those into ONE reconnect + refetch instead of a stampede.
 */
export const RESUME_DEBOUNCE_MS = 400;

interface UseAppLifecycleEventsParams {
  activeConversationIdRef: MutableRefObject<string | null>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  chatAbortRef: MutableRefObject<AbortController | null>;
  setConversationMessages: (
    updater:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  /**
   * Full-replace reload of a conversation's messages from the server. Called on
   * resume so agent messages emitted while the app was backgrounded appear \u2014
   * the only re-sync path for dedicated-agent REST mode (no WS to reconnect).
   */
  loadConversationMessages: (
    convId: string,
  ) => Promise<LoadConversationMessagesResult>;
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
    // error-policy:J4 resume health probe — an unreachable agent IS the
    // unhealthy signal; the caller reacts by rediscovering the runtime.
    return false;
  }
}

export function useAppLifecycleEvents({
  activeConversationIdRef,
  conversationMessagesRef,
  chatAbortRef,
  setConversationMessages,
  loadConversationMessages,
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

  // ── APP_RESUME: reconnect + refetch tail + sweep stale placeholder ──
  //
  // Latest refs are read at fire time so the debounced sequence and the
  // pageshow bridge see current values without re-subscribing the listeners.
  const conversationMessagesRefStable = conversationMessagesRef;
  const activeConversationIdRefStable = activeConversationIdRef;
  const setConversationMessagesRef = useRef(setConversationMessages);
  setConversationMessagesRef.current = setConversationMessages;
  const loadConversationMessagesRef = useRef(loadConversationMessages);
  loadConversationMessagesRef.current = loadConversationMessages;

  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    // Sweep the "last assistant turn is an empty streaming placeholder"
    // anomaly (a stream that never produced text before suspend) so the UI
    // does not show a perpetually-loading bubble after resume.
    const sweepStalePlaceholder = (): void => {
      const messages = conversationMessagesRefStable.current;
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      if (last && last.role === "assistant" && last.text === "") {
        setConversationMessagesRef.current((prev) =>
          prev.map((message) =>
            message.id === last.id
              ? { ...message, interrupted: true }
              : message,
          ),
        );
      }
    };

    // The actual resume work, run once per debounced burst.
    const runResume = (): void => {
      resumeTimer = null;

      void probeAgentHealth();

      // Force a WS reconnect / reset the reconnect backoff. iOS often does NOT
      // fire `online` on resume (the socket was silently killed during
      // suspension, not a network change), so the resumed PWA can otherwise
      // sit on a dead socket until the 30s background probe or a user action.
      // `resetConnection` clears the pending backoff timer, resets the attempt
      // counter, and re-runs `connectWs()`. For dedicated-agent REST bases
      // `connectWs()` short-circuits to connected-over-REST (no socket, no
      // churn), so this is safe when the WS is absent.
      try {
        client.resetConnection();
      } catch {
        // error-policy:J4 a reconnect that throws must not strand the refetch
        // below; the background probe loop remains a fallback.
      }

      // Refetch the active conversation tail so agent messages emitted while
      // backgrounded appear. This is the ONLY re-sync path for dedicated-agent
      // REST mode (no WS reconnect fires `onReconnect`/RESYNC_EVENT there), and
      // a belt-and-suspenders refresh for the WS path where the socket resync
      // reconciliation would otherwise be the only trigger.
      const convId = activeConversationIdRefStable.current;
      if (convId) {
        void loadConversationMessagesRef.current(convId).catch(() => {
          // error-policy:J4 resume tail refetch — a failed reload leaves the
          // last-known transcript in place; the next interaction/open retries.
        });
      }

      sweepStalePlaceholder();
    };

    // Debounce: collapse a visibilitychange-driven APP_RESUME_EVENT and a
    // near-simultaneous bfcache pageshow (and rapid fg/bg flips) into one run.
    const scheduleResume = (): void => {
      if (resumeTimer !== null) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(runResume, RESUME_DEBOUNCE_MS);
    };

    const onResume = (): void => {
      scheduleResume();
    };

    // ── D3: bfcache restore ──
    // iOS commonly restores an installed PWA from the back/forward cache
    // (bfcache) where `visibilitychange` alone can miss the resume trigger. A
    // `pageshow` with `persisted === true` means the page came back from
    // bfcache with a frozen (dead) socket \u2014 treat it as a resume. A
    // non-persisted pageshow is a normal load (boot already connects), so it
    // is ignored. Sharing `scheduleResume` dedupes against a visibilitychange
    // APP_RESUME_EVENT that fires in the same tick.
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) scheduleResume();
    };

    document.addEventListener(APP_RESUME_EVENT, onResume);
    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", onPageShow);
    }

    return () => {
      if (resumeTimer !== null) clearTimeout(resumeTimer);
      document.removeEventListener(APP_RESUME_EVENT, onResume);
      if (typeof window !== "undefined") {
        window.removeEventListener("pageshow", onPageShow);
      }
    };
    // Listeners subscribe once and read the latest handlers/values through
    // refs, so they never re-subscribe (avoids tearing down a pending
    // debounce mid-resume). `client` is module-stable.
  }, [conversationMessagesRefStable, activeConversationIdRefStable]);
}
