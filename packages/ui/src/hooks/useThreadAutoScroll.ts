// Single auto-scroll / at-bottom / jump-to-latest engine for chat threads (#12348).
//
// Both chat surfaces that own their own scroller — the homescreen `ChatSurface`
// mini-chat and (to follow) the continuous overlay — used to hand-roll the same
// three behaviours: pin to the newest line while the reader rests at the bottom,
// do NOT yank a reader who has scrolled up to read history, and coalesce the
// bottom-follow write into a single rAF so a streamed token never forces a
// synchronous reflow. This hook is that logic, once, with the at-bottom state
// promoted to a real value so a "jump to latest" affordance can render when the
// reader has scrolled away (previously no surface had one).
//
// It is scroll math only — no chrome, no message shape. The caller wires the
// returned `scrollRef` to its scroller, reads `atBottom` to gate a jump control,
// and calls `jumpToLatest()` from that control.

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

export interface ThreadAutoScrollHandle<T extends HTMLElement> {
  /** Attach to the scrolling container. */
  scrollRef: React.RefObject<T | null>;
  /**
   * True while the reader is resting at (or within {@link AT_BOTTOM_THRESHOLD_PX}
   * of) the bottom. Drives the visibility of a jump-to-latest control: show it
   * only when this is false.
   */
  atBottom: boolean;
  /** Scroll to the newest line and re-pin follow. Bound to the jump control. */
  jumpToLatest: () => void;
}

export interface ThreadAutoScrollOptions {
  /**
   * A value that changes whenever the thread grows or its tail mutates
   * (message count, or `${count}:${lastMessageId}:${lastContent.length}` to
   * follow streamed tokens). The follow pass runs after each change.
   */
  growthKey: string | number;
  /** Skip the smooth scroll and jump instantly (honour reduced-motion). */
  reduceMotion?: boolean;
}

/**
 * Auto-scroll a chat thread: follow the tail while the reader is at the bottom,
 * leave them alone when they have scrolled up, and expose `atBottom` +
 * `jumpToLatest` so the surface can offer a jump-to-latest control.
 *
 * The first growth after mount pins instantly (no animation, no "started at the
 * top" flash). Subsequent growth while at-bottom follows; a smooth scroll is
 * used unless `reduceMotion` is set. Growth while the reader is scrolled up does
 * nothing — `atBottom` flips false so the caller can surface the jump control.
 */
export function useThreadAutoScroll<T extends HTMLElement = HTMLDivElement>({
  growthKey,
  reduceMotion = false,
}: ThreadAutoScrollOptions): ThreadAutoScrollHandle<T> {
  const scrollRef = useRef<T | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const followRaf = useRef<number | null>(null);
  const hasPinnedRef = useRef(false);

  const syncAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(measureAtBottom(el));
  }, []);

  // Track the reader's position so `atBottom` stays truthful as they scroll,
  // independent of thread growth. Passive: this only reads layout.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncAtBottom();
    el.addEventListener("scroll", syncAtBottom, { passive: true });
    return () => el.removeEventListener("scroll", syncAtBottom);
  }, [syncAtBottom]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (reduceMotion) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
    setAtBottom(true);
  }, [reduceMotion]);

  // Follow thread growth. First growth pins synchronously (pre-paint) so the
  // thread never flashes at the top; later growth coalesces into one rAF and
  // only follows when the reader is already at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: growthKey is the intentional change-trigger; the body reads live layout via the ref, not growthKey.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const firstPin = !hasPinnedRef.current;
    hasPinnedRef.current = true;

    if (firstPin || measureAtBottom(el)) {
      if (followRaf.current != null) cancelAnimationFrame(followRaf.current);
      followRaf.current = requestAnimationFrame(() => {
        followRaf.current = null;
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        setAtBottom(true);
      });
    } else {
      // Reader is scrolled up — do not yank them; just reflect that new content
      // is below so the jump control shows.
      setAtBottom(false);
    }

    return () => {
      if (followRaf.current != null) {
        cancelAnimationFrame(followRaf.current);
        followRaf.current = null;
      }
    };
  }, [growthKey]);

  return { scrollRef, atBottom, jumpToLatest };
}
