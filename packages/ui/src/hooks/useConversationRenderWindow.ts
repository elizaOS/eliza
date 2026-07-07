/**
 * Bounded render window for a chat transcript — the one engine behind ChatView,
 * the ContinuousChatOverlay, and the infinite-scroll e2e fixture (#15281,
 * #14329, #9955). State keeps every loaded turn; only the DOM is bounded.
 *
 * The window opens at MAX_RENDERED_SHELL_MESSAGES so even a long thread mounts a
 * lean subtree, and grows a page at a time on scroll-to-top: first revealing
 * already-loaded-but-windowed-out turns (network-free), then paging the next
 * older server window once the window has drained — bounded by
 * MAX_LOADED_SHELL_WINDOW so the DOM can never unbound. The reveal-before-fetch
 * policy itself is {@link planScrollTopLoadOlder} in shell-state (pure,
 * unit-tested there); this hook owns the React state, the async fetch
 * continuation with a conversation-switch guard, and the search-jump reveal.
 *
 * The caller feeds `renderableCount` (its filtered/loaded turn count) and
 * `conversationKey` (window + loader reset on change), and wires the result:
 * `windowSize` into its `slice(-windowSize)`, `onLoadOlder` into
 * useLoadOlderOnScroll.onLoadOlder, and `canLoadOlder` (ANDed with any
 * surface-specific gates) into its hasMore. For a keyword-search jump to a hit
 * older than the window, the surface subscribes to
 * CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT and calls `revealFullWindow`.
 *
 * The reveal is DERIVED state (a `revealed` flag → windowSize recomputed from
 * the current renderable count every render), never a ref read at emit time: the
 * event fires from the sidebar's async continuation and the surface may not have
 * re-rendered with the replaced (centered) thread yet, so a ref read would race
 * the around-load's setState and drop the pivot — the #9955 silent-jump failure.
 * Deriving each render instead tracks the around-load's landing whenever it
 * commits.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_LOADED_SHELL_WINDOW,
  MAX_RENDERED_SHELL_MESSAGES,
  planScrollTopLoadOlder,
} from "../components/shell/shell-state";
import type { LoadOlderResult } from "../state/load-older-conversation-messages";

/**
 * View-event signal from the conversations sidebar's keyword-search jump: after
 * a centered around-load lands the hit's page, this asks the active transcript
 * to render its full loaded set (capped at the DOM bound) so the pivot mounts
 * and the jump can scroll to it. Emitted with no payload — it targets whichever
 * chat surface is mounted.
 */
export const CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT =
  "chat-transcript-reveal-window";

export interface ConversationRenderWindowOptions {
  /** Count of filtered, loaded turns currently in state (e.g. visibleMsgs.length). */
  renderableCount: number;
  /** Active conversation id; the window, loader, and reveal reset on change. */
  conversationKey: string | null;
  /**
   * Fetch + prepend the next older server page. The caller wraps
   * loadOlderConversationMessages (keeping its own prepend/active-id guard) and
   * RETURNS the result — this hook drives paging state off `hasMore` /
   * `prependedCount` rather than the caller setting it.
   */
  fetchOlder: () => Promise<LoadOlderResult>;
}

export interface ConversationRenderWindow {
  /** Effective window — feed the transcript `slice(-windowSize)`. */
  windowSize: number;
  /** Wire to useLoadOlderOnScroll.onLoadOlder: reveal-before-fetch, then page. */
  onLoadOlder: () => Promise<void>;
  /** AND with surface gates and feed useLoadOlderOnScroll.hasMore. */
  canLoadOlder: boolean;
  /** Search-jump: render the full loaded set (capped at MAX_LOADED_SHELL_WINDOW). */
  revealFullWindow: () => void;
}

export function useConversationRenderWindow({
  renderableCount,
  conversationKey,
  fetchOlder,
}: ConversationRenderWindowOptions): ConversationRenderWindow {
  // The scroll-driven window floor. Grown a page per scroll-to-top and by a
  // real prepend's size; collapsed back on a conversation switch.
  const [baseWindow, setBaseWindow] = useState(MAX_RENDERED_SHELL_MESSAGES);
  // Server-reported "more older turns exist". Starts true (unknown until the
  // first fetch) and latches false at the true top.
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  // Set by a search-jump; makes windowSize track the loaded count so a hit
  // centered deep in an around-loaded page mounts.
  const [revealed, setRevealed] = useState(false);

  // Derived each render so a reveal (or a later prepend growing renderableCount)
  // is reflected the moment it commits — the race-free property above.
  const windowSize = revealed
    ? Math.min(Math.max(baseWindow, renderableCount), MAX_LOADED_SHELL_WINDOW)
    : baseWindow;

  // Live mirrors so onLoadOlder keeps a stable identity while reading current
  // values (the overlay pattern) — the scroll observer captures it once.
  const windowSizeRef = useRef(windowSize);
  windowSizeRef.current = windowSize;
  const renderableCountRef = useRef(renderableCount);
  renderableCountRef.current = renderableCount;
  const hasMoreOlderRef = useRef(hasMoreOlder);
  hasMoreOlderRef.current = hasMoreOlder;
  const conversationKeyRef = useRef(conversationKey);
  conversationKeyRef.current = conversationKey;
  const fetchOlderRef = useRef(fetchOlder);
  fetchOlderRef.current = fetchOlder;

  const onLoadOlder = useCallback(async () => {
    const plan = planScrollTopLoadOlder(
      windowSizeRef.current,
      renderableCountRef.current,
      hasMoreOlderRef.current,
    );
    if (plan.nextWindowSize !== windowSizeRef.current) {
      setBaseWindow(plan.nextWindowSize);
    }
    if (!plan.shouldFetch) return;
    const key = conversationKeyRef.current;
    const result = await fetchOlderRef.current();
    // A page that resolved after a conversation switch belongs to the previous
    // thread — drop it so it can neither re-arm paging nor grow the window for
    // the newly active one.
    if (conversationKeyRef.current !== key) return;
    setHasMoreOlder(result.hasMore);
    if (result.prependedCount > 0) {
      setBaseWindow((n) =>
        Math.min(n + result.prependedCount, MAX_LOADED_SHELL_WINDOW),
      );
    }
  }, []);

  // A switched conversation may have its own older history — re-arm the loader,
  // collapse the window to the lean initial size, and clear a prior reveal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationKey is the intentional reset trigger; the body only calls stable setters.
  useEffect(() => {
    setBaseWindow(MAX_RENDERED_SHELL_MESSAGES);
    setHasMoreOlder(true);
    setRevealed(false);
  }, [conversationKey]);

  const canLoadOlder =
    windowSize < MAX_LOADED_SHELL_WINDOW &&
    (windowSize < renderableCount || hasMoreOlder);

  const revealFullWindow = useCallback(() => setRevealed(true), []);

  return { windowSize, onLoadOlder, canLoadOlder, revealFullWindow };
}
