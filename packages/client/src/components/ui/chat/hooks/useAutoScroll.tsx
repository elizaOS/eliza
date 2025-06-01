// @hidden
import { useCallback, useEffect, useRef, useState } from 'react';

interface ScrollState {
  isAtBottom: boolean;
  autoScrollEnabled: boolean;
}

interface UseAutoScrollOptions {
  offset?: number;
  smooth?: boolean;
  // content?: React.ReactNode; // Removed as it's an indirect dependency, watching scrollHeight is better
}

export function useAutoScroll(options: UseAutoScrollOptions = {}) {
  const { offset = 20, smooth = false } = options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastContentHeight = useRef(0);
  const userHasScrolled = useRef(false); // To track if user manually scrolled up

  const [scrollState, setScrollState] = useState<ScrollState>({
    isAtBottom: true,
    autoScrollEnabled: true,
  });

  const checkIsAtBottom = useCallback(
    (element: HTMLElement) => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      const distanceToBottom = Math.abs(scrollHeight - scrollTop - clientHeight);
      return distanceToBottom <= offset;
    },
    [offset]
  );

  const scrollToBottom = useCallback(
    (instant?: boolean) => {
      if (!scrollRef.current) return;
      const targetScrollTop = scrollRef.current.scrollHeight - scrollRef.current.clientHeight;
      scrollRef.current.scrollTo({
        top: targetScrollTop,
        behavior: instant ? 'auto' : smooth ? 'smooth' : 'auto',
      });
      // When we programmatically scroll to bottom, user is at bottom and autoScroll should be enabled
      setScrollState({ isAtBottom: true, autoScrollEnabled: true });
      userHasScrolled.current = false;
    },
    [smooth] // Removed checkIsAtBottom from here as it's not directly used, but ensure offset changes are handled if it affects logic elsewhere
  );

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const atBottom = checkIsAtBottom(scrollRef.current);

    if (atBottom) {
      // If user scrolls to the bottom, reset userHasScrolled and re-enable autoScroll
      userHasScrolled.current = false;
      setScrollState({ isAtBottom: true, autoScrollEnabled: true });
    } else {
      // User is not at the bottom. If userHasScrolled.current is true, it means they scrolled up.
      // Keep autoScrollEnabled as false. If it was a programmatic scroll not to bottom, this state will reflect that.
      setScrollState(prev => ({ ...prev, isAtBottom: false, autoScrollEnabled: userHasScrolled.current ? false : prev.autoScrollEnabled }));
    }
  }, [checkIsAtBottom]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // This effect reacts to new content (scrollHeight changes)
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const currentHeight = scrollElement.scrollHeight;
    // Only act if height actually changed to avoid unnecessary processing
    if (currentHeight !== lastContentHeight.current) {
      if (currentHeight > lastContentHeight.current) { // Content added
        if (scrollState.autoScrollEnabled && !userHasScrolled.current) {
          requestAnimationFrame(() => {
            scrollToBottom(lastContentHeight.current === 0); // Instant if first load, otherwise respect smooth option implicitly
          });
        }
      }
      lastContentHeight.current = currentHeight; // Update height regardless
    }
  }, [scrollRef.current?.scrollHeight, scrollState.autoScrollEnabled, scrollToBottom]); // Dependency on scrollHeight

  // ResizeObserver to handle container resizes (e.g., keyboard, devtools)
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver(() => {
      // Only auto-scroll on resize if user hasn't manually scrolled up and autoScroll is generally enabled
      if (scrollState.autoScrollEnabled && !userHasScrolled.current) {
        // It might be better to scroll smoothly here unless it's a major resize like orientation change
        scrollToBottom(false);
      }
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [scrollState.autoScrollEnabled, scrollToBottom]);

  const disableAutoScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const atBottom = checkIsAtBottom(scrollRef.current);
    if (!atBottom) {
      userHasScrolled.current = true; // User has taken control by scrolling up
      setScrollState(prev => ({
        ...prev,
        autoScrollEnabled: false, // Disable auto-scroll
      }));
    }
  }, [checkIsAtBottom]);

  return {
    scrollRef,
    isAtBottom: scrollState.isAtBottom,
    autoScrollEnabled: scrollState.autoScrollEnabled,
    scrollToBottom: () => scrollToBottom(false), // Expose a non-instant scroll by default
    disableAutoScroll,
  };
}
