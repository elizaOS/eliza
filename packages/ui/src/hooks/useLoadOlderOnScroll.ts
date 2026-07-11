/**
 * Infinite upward scroll for a chat transcript (#13532, epic #13539).
 *
 * Companion to {@link useThreadAutoScroll} (which owns bottom-follow). This
 * hook owns the OTHER direction: as the reader scrolls
 * toward older messages it asynchronously fetches + prepends a page, and it
 * does so WITHOUT a visible jump — the message that was at the top before the
 * prepend stays visually put.
 *
 * Three responsibilities, all here so prefetch + preservation live in one place
 * rather than being duplicated across ChatView / InboxChatPanel / the overlay:
 *
 *  1. **Trigger before the literal top.** A top sentinel + IntersectionObserver
 *     (with a positive `rootMargin`) fires the load a viewport-fraction BEFORE
 *     the reader reaches the very first line, so the older page is usually
 *     already prepended by the time they get there — no "wall then wait".
 *
 *  2. **In-flight guard.** A ref gates concurrent scroll-ups so a fast flick
 *     (or the sentinel re-intersecting mid-fetch) can't double-fetch the same
 *     page. `hasMore=false` latches the loader off entirely.
 *
 *  3. **Scroll-anchor preservation.** Older content grows the scroller UPWARD,
 *     which would shove the reader's viewport down by the grown height. We
 *     capture `scrollHeight` immediately before requesting the grow and, in a
 *     layout effect after the DOM has grown, add the height delta back to
 *     `scrollTop`. Net viewport motion: zero.
 *
 * It is scroll math + fetch orchestration only — the caller owns the state
 * (passes `onLoadOlder`, `hasMore`, and a `topItemKey` that changes when the
 * thread's FIRST item changes so the preservation effect knows a prepend
 * landed). The caller wires `sentinelRef` above the first message row and
 * shares the SAME scroller node with `useThreadAutoScroll` via `scrollRef`.
 */

import { logger } from "@elizaos/logger";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * How far before the literal top (as a fraction of the viewport height) the
 * older-page prefetch fires. 1 = one full viewport of runway; the reader
 * should never see the top sentinel come to rest.
 */
const PREFETCH_VIEWPORT_MARGIN = 1;

export interface LoadOlderOnScrollOptions<T extends HTMLElement> {
  /** The shared scroller node (same one wired to useThreadAutoScroll). */
  scrollRef: React.RefObject<T | null>;
  /** A sentinel element rendered just ABOVE the first message row. */
  sentinelRef: React.RefObject<HTMLElement | null>;
  /**
   * Fetch + prepend one older page. Resolves when the state has been updated
   * (the prepend dispatched). Rejection/throw is swallowed by the guard so a
   * transient fetch failure just re-arms on the next scroll-up.
   */
  onLoadOlder: () => Promise<void>;
  /** False once the true top is reached — latches the loader off. */
  hasMore: boolean;
  /**
   * Changes whenever the thread's FIRST (oldest) item changes — e.g. the id of
   * `messages[0]`. The preservation effect runs on this change: a prepend moved
   * the first item, so restore the reader's viewport by the grown height.
   */
  topItemKey: string | number;
  /**
   * Gates the observer while the scroller is hidden/unmounted (the overlay's
   * closed sheet). Default true.
   */
  enabled?: boolean;
}

/**
 * Wire infinite upward scroll onto a chat scroller. Returns nothing — all
 * effects are side effects on the passed refs.
 */
export function useLoadOlderOnScroll<T extends HTMLElement = HTMLDivElement>({
  scrollRef,
  sentinelRef,
  onLoadOlder,
  hasMore,
  topItemKey,
  enabled = true,
}: LoadOlderOnScrollOptions<T>): void {
  // True while a page fetch is in flight — blocks concurrent scroll-ups from
  // double-fetching. A ref (not state) so the observer callback reads it
  // synchronously without re-subscribing.
  const loadingRef = useRef(false);
  // Scroll height captured immediately BEFORE the grow, so the post-grow layout
  // effect can restore scrollTop by the exact delta. Null when no prepend is
  // pending preservation.
  const pendingAnchorHeightRef = useRef<number | null>(null);
  // Latest onLoadOlder without re-subscribing the observer on every render.
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  // The first-item key we last SAW — the preservation effect only restores on a
  // genuine change (a prepend), never on mount or an unrelated re-render.
  const lastTopKeyRef = useRef(topItemKey);

  const triggerLoadOlder = useCallback(() => {
    if (loadingRef.current || !hasMoreRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    loadingRef.current = true;
    // Capture the pre-grow height NOW; the reducer prepends synchronously on
    // resolve and React commits the taller DOM before the layout effect below.
    pendingAnchorHeightRef.current = el.scrollHeight;
    void onLoadOlderRef
      .current()
      .catch((err: unknown) => {
        // error-policy:J4 the transcript above stays intact and the next
        // scroll-up retries the page; logged so a persistently failing
        // load-older endpoint is not silent. Drop the pending anchor so we
        // don't wrongly adjust scrollTop on the next unrelated top-item change.
        logger.warn({ err }, "[useLoadOlderOnScroll] older-page load failed");
        pendingAnchorHeightRef.current = null;
      })
      .finally(() => {
        loadingRef.current = false;
        // Clear any anchor the preservation effect did NOT consume. A load that
        // prepends nothing (empty / fully-deduped / fully-filtered older page)
        // leaves topItemKey unchanged, so the preservation layout effect never
        // runs and the pre-grow height would otherwise stay parked — then a
        // later UNRELATED top-key change (e.g. a conversation switch) would
        // apply a bogus scrollTop delta.
        //
        // DOUBLE rAF (not single): a real prepend's React commit + preservation
        // layout effect are scheduled off the SAME promise resolution as this
        // finally, and their relative order is engine-dependent — on WebKit the
        // commit routinely lands a frame LATER than a single rAF, so a
        // single-frame expiry nulled the anchor before the effect consumed it
        // and every ~3rd prepend jumped the viewport ~1 screen (verified via the
        // webkit lane of run-chat-infinite-scroll-e2e). Two frames of runway
        // reliably outlast the commit while still expiring long before any
        // real user-driven unrelated top-key change.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            pendingAnchorHeightRef.current = null;
          });
        });
      });
  }, [scrollRef]);

  // Top-sentinel observer: fire the prefetch a viewport BEFORE the literal top.
  // `hasMore` is an intentional dependency (not just read via ref): once it
  // flips false there is nothing older to observe, so we tear the observer down;
  // the false→true edge on a conversation switch re-subscribes.
  //
  // `topItemKey` is ALSO an intentional dependency (#13953): callers render the
  // sentinel only in the transcript's non-empty branch, so on the INITIAL open
  // of a conversation the first effect run sees `sentinelRef.current === null`
  // and bails without observing. Messages then land asynchronously and mount
  // the sentinel — but mutating a ref never re-runs an effect, and none of the
  // other deps are guaranteed to change on the empty→populated transition, so
  // without this dep the observer would never attach and scroll-up load-older
  // would be silently dead. `topItemKey` changes exactly when the first item
  // changes (empty→populated, conversation switch, prepend), so it doubles as
  // the "sentinel (re)mounted" signal: the effect re-runs, sees the mounted
  // sentinel, and subscribes. It also tears down + re-binds across a
  // conversation switch that transiently clears the thread to [] — the old
  // (now detached) sentinel is dropped instead of being observed forever. A
  // re-subscribe after an ordinary prepend is cheap (disconnect + observe) and
  // an immediately-intersecting sentinel just continues paging, which the
  // in-flight guard already serializes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasMore + topItemKey are intentional re-subscribe triggers; the callback reads live gates via refs.
  useEffect(() => {
    if (!enabled) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            triggerLoadOlder();
          }
        }
      },
      {
        root,
        // Positive top margin extends the observer's root ABOVE the viewport so
        // the sentinel counts as visible a viewport-height early.
        rootMargin: `${Math.round(root.clientHeight * PREFETCH_VIEWPORT_MARGIN)}px 0px 0px 0px`,
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-subscribe when the scroller (re)mounts, hasMore flips, or the first
    // item changes (topItemKey) — the latter is what attaches the observer once
    // the sentinel mounts on the empty→populated transition (#13953).
  }, [enabled, hasMore, topItemKey, scrollRef, sentinelRef, triggerLoadOlder]);

  // Preserve viewport on prepend: after the older page grew the scroller
  // upward, add the height delta back to scrollTop so the previously-top
  // message stays exactly where the reader was looking.
  useLayoutEffect(() => {
    if (topItemKey === lastTopKeyRef.current) return;
    lastTopKeyRef.current = topItemKey;
    const el = scrollRef.current;
    const prevHeight = pendingAnchorHeightRef.current;
    pendingAnchorHeightRef.current = null;
    if (!el || prevHeight === null) return;
    const delta = el.scrollHeight - prevHeight;
    if (delta > 0) {
      el.scrollTop += delta;
    }
  }, [topItemKey, scrollRef]);
}
