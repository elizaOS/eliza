// Enhanced with StickToBottom for better UX
import { useCallback, useRef, useState, useEffect } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

interface ScrollState {
  isAtBottom: boolean;
  autoScrollEnabled: boolean;
}

interface UseAutoScrollOptions {
  offset?: number;
  smooth?: boolean;
}

export function useAutoScroll(options: UseAutoScrollOptions = {}) {
  const { smooth = false } = options;
  const userHasScrolled = useRef(false); // To track if user manually scrolled up

  // Use StickToBottom for enhanced scroll behavior
  const stickToBottom = useStickToBottom({
    initial: smooth ? 'smooth' : 'instant',
    resize: smooth ? 'smooth' : 'instant',
  });

  const [scrollState, setScrollState] = useState<ScrollState>({
    isAtBottom: true,
    autoScrollEnabled: true,
  });

  // Sync our state with StickToBottom's state
  useEffect(() => {
    const isAtBottom = stickToBottom.isAtBottom;

    if (isAtBottom) {
      // User is at bottom - reset user control and enable auto-scroll
      userHasScrolled.current = false;
      setScrollState({ isAtBottom: true, autoScrollEnabled: true });
    } else {
      // User is not at bottom
      setScrollState((prev) => ({
        ...prev,
        isAtBottom: false,
        autoScrollEnabled: userHasScrolled.current ? false : prev.autoScrollEnabled,
      }));
    }
  }, [stickToBottom.isAtBottom]);

  // Enhanced scroll to bottom using StickToBottom
  const scrollToBottom = useCallback(
    (instant?: boolean) => {
      const animation = instant ? 'instant' : smooth ? 'smooth' : 'instant';
      stickToBottom.scrollToBottom({
        animation,
        preserveScrollPosition: false, // Always scroll to bottom when called
      });

      // Update our state
      setScrollState({ isAtBottom: true, autoScrollEnabled: true });
      userHasScrolled.current = false;
    },
    [stickToBottom.scrollToBottom, smooth]
  );

  // Enhanced disable auto-scroll using StickToBottom
  const disableAutoScroll = useCallback(() => {
    if (!stickToBottom.isAtBottom) {
      userHasScrolled.current = true; // User has taken control by scrolling up
      stickToBottom.stopScroll(); // Stop any ongoing scroll animations
      setScrollState((prev) => ({
        ...prev,
        autoScrollEnabled: false, // Disable auto-scroll
      }));
    }
  }, [stickToBottom.isAtBottom, stickToBottom.stopScroll]);

  return {
    scrollRef: stickToBottom.scrollRef,
    contentRef: stickToBottom.contentRef, // Expose content ref for proper StickToBottom usage
    isAtBottom: scrollState.isAtBottom,
    autoScrollEnabled: scrollState.autoScrollEnabled,
    scrollToBottom: () => scrollToBottom(false), // Expose a non-instant scroll by default
    disableAutoScroll,
    // Expose StickToBottom instance for advanced usage if needed
    _stickToBottom: stickToBottom,
  };
}
