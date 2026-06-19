/**
 * useOnClickOutside hook
 *
 * Detects clicks outside of a referenced element and triggers a callback.
 * Useful for closing dropdowns, modals, and other overlay elements.
 *
 * @example
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * useOnClickOutside(ref, () => setIsOpen(false));
 * ```
 */

import { type RefObject, useEffect } from "react";

type EventType = "mousedown" | "mouseup" | "touchstart" | "touchend";

/**
 * Hook that triggers callback when clicking outside the referenced element
 *
 * @param ref - React ref to the element to monitor
 * @param handler - Callback function to execute on outside click
 * @param eventType - Mouse event type to listen for (default: 'mousedown')
 */
export function useOnClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  eventType: EventType = "mousedown",
): void {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current;
      // Do nothing if clicking ref's element or its descendants
      if (!el || el.contains(event.target as Node)) {
        return;
      }
      handler();
    };

    document.addEventListener(eventType, listener);
    return () => document.removeEventListener(eventType, listener);
  }, [ref, handler, eventType]);
}
