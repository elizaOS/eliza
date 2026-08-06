"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseAriaLiveOptions {
  politeness?: "polite" | "assertive";
  /** Delay in ms before the message is injected — allows the region to reset first */
  delay?: number;
}

interface UseAriaLiveReturn {
  /** The current announcement string — render this inside an aria-live region */
  announcement: string;
  /** Call this to trigger a new announcement */
  announce: (message: string) => void;
  /** Props to spread onto your aria-live container element */
  liveRegionProps: {
    role: "status";
    "aria-live": "polite" | "assertive";
    "aria-atomic": true;
  };
}

/**
 * Hook-based aria-live region manager.
 * Returns an `announcement` string to render inside a visually-hidden container
 * and an `announce` function to update it.
 *
 * @example
 * const { announcement, announce, liveRegionProps } = useAriaLive();
 *
 * // Trigger
 * announce("Message sent");
 *
 * // Render (visually hidden)
 * <div {...liveRegionProps} className="sr-only">{announcement}</div>
 */
export function useAriaLive({
  politeness = "polite",
  delay = 50,
}: UseAriaLiveOptions = {}): UseAriaLiveReturn {
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback(
    (message: string) => {
      setAnnouncement("");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setAnnouncement(message), delay);
    },
    [delay]
  );

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return {
    announcement,
    announce,
    liveRegionProps: {
      role: "status",
      "aria-live": politeness,
      "aria-atomic": true,
    },
  };
}
