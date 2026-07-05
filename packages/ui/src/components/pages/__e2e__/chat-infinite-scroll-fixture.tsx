/**
 * REAL-browser fixture for the infinite upward scroll (#13532/#14329) — driven
 * by run-chat-infinite-scroll-e2e.mjs.
 *
 * Mounts the PRODUCTION load-older engine — the real `useLoadOlderOnScroll`
 * hook, the real `loadOlderConversationMessages` orchestration, AND the real
 * `planScrollTopLoadOlder` render-window policy — over a real scroller in a real
 * Chromium layout, so the pieces jsdom fakes (a genuine IntersectionObserver,
 * real scrollHeight/scrollTop geometry, a real `?before=` network fetch) run for
 * real. Crucially it renders through the SAME sliding render window the overlay
 * uses (`messages.slice(-renderWindowSize)` growing via `planScrollTopLoadOlder`)
 * rather than dumping every message — so the e2e guards #14329's actual bug: a
 * fixed render cap that slices prepended older turns straight back off.
 *
 * Query params (set by the runner): `?empty` seeds an empty thread (no fetch
 * loop); `?fail` makes the first older-page fetch reject (error path — the guard
 * re-arms, no retry storm); `?big` mounts a thread far larger than the initial
 * render window, so scroll-up must GROW the window to reveal already-loaded
 * turns before any fetch. Default is a small multi-page thread.
 */

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ConversationMessage } from "../../../api/client-types-chat";
import { useLoadOlderOnScroll } from "../../../hooks/useLoadOlderOnScroll";
import {
  type LoadOlderClient,
  loadOlderConversationMessages,
} from "../../../state/load-older-conversation-messages";
import {
  MAX_LOADED_SHELL_WINDOW,
  MAX_RENDERED_SHELL_MESSAGES,
  planScrollTopLoadOlder,
} from "../../shell/shell-state";

const CONVERSATION_ID = "conv-infinite";
const PAGE_SIZE = 20;

type Win = typeof window & {
  /** Every `?before=` cursor the client actually fetched, in order. */
  __beforeFetches?: number[];
  /** Count of older-page loads that resolved (used to detect a retry storm). */
  __loadResolves?: number;
  /** Whether the last older-page fetch rejected. */
  __lastFetchFailed?: boolean;
  /** Live render-window size, so the runner can assert it grows past the cap. */
  __renderWindow?: number;
};

const params = new URLSearchParams(window.location.search);
const MODE_EMPTY = params.has("empty");
const MODE_FAIL = params.has("fail");
const MODE_BIG = params.has("big");

// `?big` mounts far more than the initial render window so scroll-up must reveal
// already-loaded turns (the #14329 cap-growth path). The default/fail threads
// mount a tail a full page taller than the viewport so the thread starts
// scrolled to the BOTTOM with the top sentinel off-screen — no mount-time
// prefetch — and the reader (the runner) then scrolls up deliberately.
const TAIL_SIZE = MODE_BIG ? 200 : 40;

/** Build the newest page (tail) the thread mounts with, oldest-first. */
function initialMessages(): ConversationMessage[] {
  if (MODE_EMPTY) return [];
  const now = Date.now();
  const msgs: ConversationMessage[] = [];
  for (let i = 0; i < TAIL_SIZE; i += 1) {
    msgs.push({
      id: `tail-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Tail message ${i} — the newest page mounted first.`,
      timestamp: now - (TAIL_SIZE - i) * 1000,
    });
  }
  return msgs;
}

/**
 * A real fetch-backed client. `getConversationMessages({ before })` hits the
 * stubbed endpoint so the `?before=` request is real network traffic; `?fail`
 * makes the first call reject to exercise the hook's error path.
 */
function makeClient(): LoadOlderClient {
  let failedOnce = false;
  return {
    async getConversationMessages(id, options) {
      const win = window as Win;
      const before = options?.before;
      if (typeof before === "number") {
        (win.__beforeFetches ??= []).push(before);
      }
      const url = `/api/conversations/${encodeURIComponent(id)}/messages?before=${before}&limit=${options?.limit ?? PAGE_SIZE}`;
      if (MODE_FAIL && !failedOnce) {
        failedOnce = true;
        win.__lastFetchFailed = true;
        // A real failed fetch (network-level): the hook's guard must re-arm
        // without a retry storm and surface nothing fabricated.
        throw new Error("simulated older-page fetch failure");
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`older-page fetch ${res.status}`);
      return (await res.json()) as {
        messages: ConversationMessage[];
        hasMore?: boolean;
      };
    },
  };
}

function Harness(): React.JSX.Element {
  const [messages, setMessages] = useState<ConversationMessage[]>(
    initialMessages,
  );
  const [hasMore, setHasMore] = useState(!MODE_EMPTY);
  // The render window mirrors the overlay: start lean, grow a page per
  // scroll-to-top (reveal-before-fetch), bounded by MAX_LOADED_SHELL_WINDOW.
  const [renderWindowSize, setRenderWindowSize] = useState(
    MAX_RENDERED_SHELL_MESSAGES,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<LoadOlderClient>(makeClient());
  // Refs so the scroll-up handler reads live values without re-subscribing the
  // observer — mirrors the overlay wiring exactly.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const windowRef = useRef(renderWindowSize);
  windowRef.current = renderWindowSize;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  (window as Win).__renderWindow = renderWindowSize;

  const prependMessages = useCallback((older: ConversationMessage[]) => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      return [...fresh, ...prev];
    });
  }, []);

  const onLoadOlder = useCallback(async () => {
    // Reveal-before-fetch, identical to ContinuousChatOverlay.loadOlderMessages:
    // grow the render window to surface already-loaded turns before any network,
    // and only page the next older server window once the window has drained.
    const plan = planScrollTopLoadOlder(
      windowRef.current,
      messagesRef.current.length,
      hasMoreRef.current,
    );
    if (plan.nextWindowSize !== windowRef.current) {
      setRenderWindowSize(plan.nextWindowSize);
    }
    if (!plan.shouldFetch) {
      (window as Win).__loadResolves = ((window as Win).__loadResolves ?? 0) + 1;
      return;
    }
    const result = await loadOlderConversationMessages({
      client: clientRef.current,
      conversationId: CONVERSATION_ID,
      currentMessages: messagesRef.current,
      prependMessages,
      limit: PAGE_SIZE,
    });
    (window as Win).__loadResolves = ((window as Win).__loadResolves ?? 0) + 1;
    setHasMore(result.hasMore);
    if (result.prependedCount > 0) {
      setRenderWindowSize((n) =>
        Math.min(n + result.prependedCount, MAX_LOADED_SHELL_WINDOW),
      );
    }
  }, [prependMessages]);

  const visible =
    messages.length > renderWindowSize
      ? messages.slice(-renderWindowSize)
      : messages;

  useLoadOlderOnScroll<HTMLDivElement>({
    scrollRef,
    sentinelRef,
    onLoadOlder,
    // Armed while older turns can still be revealed (window below the loaded
    // count) OR paged (server has more), and latched off at the DOM bound.
    hasMore:
      renderWindowSize < MAX_LOADED_SHELL_WINDOW &&
      (renderWindowSize < messages.length || hasMore),
    topItemKey: visible[0]?.id ?? "",
    enabled: true,
  });

  // Start pinned to the newest turn (bottom) like a real chat, so the top
  // sentinel is off-screen at mount and the older-page load only fires when the
  // runner deliberately scrolls up — never as an accidental mount prefetch.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div
      style={{
        maxWidth: 480,
        margin: "0 auto",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        ref={scrollRef}
        id="infinite-scroll-scroller"
        data-testid="infinite-scroll-scroller"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}
      >
        <div ref={sentinelRef} data-testid="infinite-scroll-top-sentinel" />
        {visible.map((m) => (
          <div
            key={m.id}
            data-message-id={m.id}
            data-testid="infinite-scroll-row"
            style={{
              padding: "10px 12px",
              margin: "8px 0",
              borderRadius: 8,
              background: m.role === "user" ? "#1c2333" : "#232a3a",
              color: "#e6ebf5",
              minHeight: 44,
            }}
          >
            {m.text}
          </div>
        ))}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
