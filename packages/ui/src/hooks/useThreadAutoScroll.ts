/**
 * Single auto-scroll and bottom-follow engine for chat threads
 * (#12348, #12188 Phase 3).
 *
 * The chat surfaces that own their own scroller — the homescreen `ChatSurface`
 * mini-chat and the continuous overlay — share the same behaviours through this
 * one hook: pin to the newest line while the reader rests at the bottom, do NOT
 * yank a reader who has scrolled up to read history, and coalesce the
 * bottom-follow write into a single rAF so a streamed token never forces a
 * synchronous reflow.
 *
 * Two optional keys split the follow behaviours: `growthKey` (tail mutation —
 * streamed tokens; instant follow) and `lineKey` (a NEW line landed; smooth
 * glide unless reduced-motion). `enabled` gates the engine for surfaces whose
 * scroller unmounts (the overlay's closed sheet) — the false→true edge re-arms
 * the instant first pin so a re-opened thread never flashes at the top.
 *
 * It is scroll math only — no chrome, no message shape. The caller wires the
 * returned ref to its scroller.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Distance from the bottom (px) within which the reader counts as "at the
// bottom" and the thread follows new content. Wider than a pixel so a
// sub-pixel rounding or a short overscroll never reads as "scrolled up".
const AT_BOTTOM_THRESHOLD_PX = 80;

function measureAtBottom(el: HTMLElement): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX
  );
}

/** Pin `el` to its bottom, gliding when smooth scrolling is requested AND the
 * environment implements it (jsdom and very old engines lack Element.scrollTo). */
function scrollToBottom(el: HTMLElement, smooth: boolean): void {
  if (smooth && typeof el.scrollTo === "function") {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

export interface ThreadAutoScrollHandle<T extends HTMLElement> {
  scrollRef: React.RefObject<T | null>;
  atBottom: boolean;
  jumpToLatest: () => void;
}

export interface ThreadAutoScrollOptions {
  growthKey: string | number;
  lineKey?: string | number;
  enabled?: boolean;
  reduceMotion?: boolean;
}

/**
 * Auto-scroll a chat thread: follow the tail while the reader is at the bottom,
 * and leave them alone when they have scrolled up.
 *
 * The first growth after mount (or after an `enabled` false→true edge) pins
 * instantly — no animation, no "started at the top" flash. Subsequent growth
 * while at-bottom follows (smooth for a `lineKey` change, instant otherwise).
 * Growth while the reader is scrolled up does nothing.
 */
export function useThreadAutoScroll<T extends HTMLElement = HTMLDivElement>({
  growthKey,
  lineKey,
  enabled = true,
  reduceMotion = false,
}: ThreadAutoScrollOptions): ThreadAutoScrollHandle<T> {
  const scrollRef = useRef<T | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const followRaf = useRef<number | null>(null);
  const hasPinnedRef = useRef(false);
  const lastLineKeyRef = useRef(lineKey);
  // Scroll height as of the previous follow pass. The growth effect runs AFTER
  // the DOM has grown, so a live measureAtBottom(el) there uses the new (larger)
  // scrollHeight against the preserved (old) scrollTop and misreads a reader
  // pinned to the bottom as "scrolled up" whenever a single commit appends more
  // than AT_BOTTOM_THRESHOLD_PX. Measuring against this pre-growth height instead
  // recovers the true pre-growth position (#12348).
  const lastGrowthHeightRef = useRef(0);

  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;

  const syncAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(measureAtBottom(el));
  }, []);

  // Track the reader's position independently of thread growth. Passive: this
  // only reads layout. Re-runs on
  // the `enabled` edge because a gated scroller (the overlay thread) mounts in
  // the same commit that enables the engine — the listener must attach then.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    syncAtBottom();
    el.addEventListener("scroll", syncAtBottom, { passive: true });
    return () => el.removeEventListener("scroll", syncAtBottom);
  }, [enabled, syncAtBottom]);

  // Re-pin the bottom when the SCROLLER'S OWN GEOMETRY changes while the reader
  // rests at the bottom — a shrink or grow that carries no thread growth so the
  // growthKey effect never fires. The overlay's send path is the motivating
  // case (#15178 device regression): sending springs the sheet to its half/full
  // detent, so the thread scroller grows over ~300ms AFTER the send-commit pin
  // already landed. Without a re-pin the settled thread strands short of the
  // newest line — the reader sends and the list doesn't follow. A soft keyboard
  // opening/closing (which shrinks/grows the scroller) is the same class of
  // geometry-only change. Gated on the reader-position ref so a reader scrolled up into
  // history is never yanked by a resize, and we only ever follow, never fight a
  // manual scroll. rAF-coalesced so a multi-frame spring settle writes once per
  // frame at most.
  useEffect(() => {
    if (!enabled) return;
    if (typeof ResizeObserver === "undefined") return;
    const el = scrollRef.current;
    if (!el) return;
    let raf: number | null = null;
    const followResize = () => {
      raf = null;
      const node = scrollRef.current;
      if (!node) return;
      // Only follow a resize for a reader who was resting at the bottom. Trust
      // the tracked reader position (kept truthful by the scroll listener)
      // rather than a live re-measure: the reflow that fires this observer may
      // have already grown the content past the at-bottom band with scrollTop
      // preserved, so a live measure would read "scrolled up" and wrongly stop
      // following — the same stale-measure trap the growth effect avoids. A
      // reader who has scrolled up is never yanked.
      if (!atBottomRef.current) return;
      node.scrollTop = node.scrollHeight;
      lastGrowthHeightRef.current = node.scrollHeight;
    };
    const ro = new ResizeObserver(() => {
      if (raf != null) return;
      if (typeof requestAnimationFrame === "function") {
        raf = requestAnimationFrame(followResize);
      } else {
        followResize();
      }
    });
    ro.observe(el);
    return () => {
      if (raf != null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf);
      }
      ro.disconnect();
    };
  }, [enabled]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollToBottom(el, !reduceMotion);
    lastGrowthHeightRef.current = el.scrollHeight;
    setAtBottom(true);
  }, [reduceMotion]);

  // Follow thread growth. First growth pins pre-paint so the thread never
  // flashes at the top; later growth coalesces into one rAF and only follows
  // when the reader is already at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: growthKey/lineKey are the intentional change-triggers; the body reads live layout via the ref.
  useLayoutEffect(() => {
    if (!enabled) {
      // Re-arm so the next enabled pass is a fresh instant pin — a re-opened
      // thread jumps straight to the newest line.
      hasPinnedRef.current = false;
      lastLineKeyRef.current = lineKey;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    const isNewLine = lineKey !== lastLineKeyRef.current;
    lastLineKeyRef.current = lineKey;

    const firstPin = !hasPinnedRef.current;
    hasPinnedRef.current = true;

    // Decide follow against the PRE-growth geometry: the DOM has already grown,
    // so measure the reader's position against the previous scroll height (with
    // the preserved scrollTop) instead of a live re-measure that would misread a
    // big single-commit append as "scrolled up". First growth always pins.
    const prevHeight = lastGrowthHeightRef.current;
    const wasAtBottom =
      prevHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    lastGrowthHeightRef.current = el.scrollHeight;

    if (!firstPin && !wasAtBottom) {
      // Reader is scrolled up — do not yank them.
      setAtBottom(false);
      return;
    }

    if (!firstPin && isNewLine && !reduceMotion) {
      // A new line while resting at the bottom glides into view rather than
      // teleporting — once per turn, so no rAF coalescing is needed. But the
      // glide must start from where the reader ACTUALLY sits, never sweep the
      // whole conversation up from the top: a thread that was short enough to
      // fit (mt-auto pins it at scrollTop 0 with no overflow) becomes scrollable
      // the instant a new line overflows it, and a smooth scroll from 0 to the
      // fresh bottom animates the entire scrollHeight — the reported "chat
      // animates from the top down to the bottom" sweep. Cap the glide to a
      // single viewport: a short hop to the new tail eases; a jump larger than
      // the viewport (the was-short-now-overflowing case, or a huge single
      // append) snaps so the follow always reads as "from here down."
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const glideDistance = maxScrollTop - el.scrollTop;
      if (glideDistance > el.clientHeight) {
        el.scrollTop = el.scrollHeight;
      } else {
        scrollToBottom(el, true);
      }
      lastGrowthHeightRef.current = el.scrollHeight;
      setAtBottom(true);
      return;
    }

    if (followRaf.current != null) cancelAnimationFrame(followRaf.current);
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = null;
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
      lastGrowthHeightRef.current = node.scrollHeight;
      setAtBottom(true);
    });

    return () => {
      if (followRaf.current != null) {
        cancelAnimationFrame(followRaf.current);
        followRaf.current = null;
      }
    };
  }, [growthKey, lineKey, enabled]);

  return { scrollRef, atBottom, jumpToLatest };
}
