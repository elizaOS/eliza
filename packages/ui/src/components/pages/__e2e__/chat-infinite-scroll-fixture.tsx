/**
 * REAL-browser fixture for the infinite upward scroll (#13532/#14329) — driven
 * by run-chat-infinite-scroll-e2e.mjs.
 *
 * Mounts the PRODUCTION load-older stack — the real `useLoadOlderOnScroll` hook,
 * the real `loadOlderConversationMessages` orchestration, AND the real
 * `useConversationRenderWindow` render-window engine — over a real scroller in a
 * real Chromium layout, so the pieces jsdom fakes (a genuine IntersectionObserver,
 * real scrollHeight/scrollTop geometry, a real `?before=` network fetch) run for
 * real. It renders through the SAME sliding render window ChatView + the overlay
 * use (`messages.slice(-renderWindow.windowSize)`) rather than dumping every
 * message — so the e2e guards #14329's actual bug: a fixed render cap that slices
 * prepended older turns straight back off.
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
import { useConversationRenderWindow } from "../../../hooks/useConversationRenderWindow";
import { useLoadOlderOnScroll } from "../../../hooks/useLoadOlderOnScroll";
import {
  type LoadOlderClient,
  loadOlderConversationMessages,
} from "../../../state/load-older-conversation-messages";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<LoadOlderClient>(makeClient());
  // Live messages for the fetch wrapper so the render window's stable
  // onLoadOlder reads the current thread without re-subscribing the observer.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const prependMessages = useCallback((older: ConversationMessage[]) => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      return [...fresh, ...prev];
    });
  }, []);

  // The PRODUCTION fetch orchestration, wrapped exactly as ChatView / the
  // overlay wrap it — returns the LoadOlderResult so the shared render window
  // drives its own paging state.
  const fetchOlder = useCallback(
    () =>
      loadOlderConversationMessages({
        client: clientRef.current,
        conversationId: CONVERSATION_ID,
        currentMessages: messagesRef.current,
        prependMessages,
        limit: PAGE_SIZE,
      }),
    [prependMessages],
  );

  // The PRODUCTION render-window engine — the same hook ChatView + the overlay
  // use. Its reveal-before-fetch policy is what this e2e exercises in real
  // Chromium (jsdom can't).
  const renderWindow = useConversationRenderWindow({
    renderableCount: messages.length,
    conversationKey: CONVERSATION_ID,
    fetchOlder,
  });
  (window as Win).__renderWindow = renderWindow.windowSize;

  // Preserve the runner's instrumentation contract: count every COMPLETED
  // older-page load (reveal or fetch) so the ?fail lane can assert "no retry
  // storm". A rejected fetch propagates to useLoadOlderOnScroll's boundary
  // WITHOUT bumping the counter — matching the guard's bounded re-arm.
  const onLoadOlder = useCallback(async () => {
    await renderWindow.onLoadOlder();
    const win = window as Win;
    win.__loadResolves = (win.__loadResolves ?? 0) + 1;
  }, [renderWindow.onLoadOlder]);

  const visible =
    messages.length > renderWindow.windowSize
      ? messages.slice(-renderWindow.windowSize)
      : messages;

  useLoadOlderOnScroll<HTMLDivElement>({
    scrollRef,
    sentinelRef,
    onLoadOlder,
    hasMore: renderWindow.canLoadOlder,
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
