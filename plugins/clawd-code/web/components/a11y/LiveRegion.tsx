"use client";

import { useEffect, useRef, useState } from "react";

interface LiveRegionProps {
  /** The message to announce. Changing this value triggers an announcement. */
  message: string;
  /**
   * "polite" — waits for user to be idle (new chat messages, status updates)
   * "assertive" — interrupts immediately (errors, critical alerts)
   */
  politeness?: "polite" | "assertive";
}

/**
 * Managed aria-live region that announces dynamic content to screen readers.
 * Clears after 500 ms to ensure repeated identical messages are re-announced.
 */
export function LiveRegion({ message, politeness = "polite" }: LiveRegionProps) {
  const [announced, setAnnounced] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!message) return;

    // Clear first to force re-announcement of identical messages
    setAnnounced("");
    timerRef.current = setTimeout(() => setAnnounced(message), 50);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [message]);

  return (
    <div
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      style={{
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: 0,
        margin: "-1px",
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        borderWidth: 0,
      }}
    >
      {announced}
    </div>
  );
}
