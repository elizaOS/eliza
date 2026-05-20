"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hook for managing animated collapsible height transitions.
 *
 * Provides smooth height animations for expand/collapse interactions
 * using scrollHeight measurement and requestAnimationFrame for proper
 * CSS transitions.
 *
 * @param isOpen - Whether the collapsible content is expanded
 * @returns Object containing contentRef to attach to the content wrapper
 *          and height value for the container style
 *
 * @example
 * ```tsx
 * function MyCollapsible({ isOpen, children }) {
 *   const { contentRef, height } = useCollapsibleHeight(isOpen);
 *
 *   return (
 *     <div style={{
 *       height: height === undefined ? 'auto' : height,
 *       overflow: 'hidden',
 *       transition: 'height 200ms ease-out',
 *     }}>
 *       <div ref={contentRef}>{children}</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useCollapsibleHeight(isOpen: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const didMountRef = useRef(false);
  const [height, setHeight] = useState<number | undefined>(
    isOpen ? undefined : 0,
  );

  useEffect(() => {
    // Skip animation on initial mount when already closed
    // (height is already initialized to 0, no need to animate)
    if (!didMountRef.current) {
      didMountRef.current = true;
      if (!isOpen) return undefined;
    }

    if (!contentRef.current) return undefined;

    if (isOpen) {
      // Opening: animate from 0 to scrollHeight, then set to auto
      const contentHeight = contentRef.current.scrollHeight;
      setHeight(contentHeight);
      // After animation completes, set to auto for dynamic content
      const timer = setTimeout(() => setHeight(undefined), 200);
      return () => clearTimeout(timer);
    }

    // Closing: First set to current height, then animate to 0
    const contentHeight = contentRef.current.scrollHeight;
    setHeight(contentHeight);
    let cancelled = false;
    requestAnimationFrame(() => {
      if (!cancelled) {
        setHeight(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return { contentRef, height };
}
