"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface AnnouncerContextValue {
  announce: (message: string, politeness?: "polite" | "assertive") => void;
}

const AnnouncerContext = createContext<AnnouncerContextValue | null>(null);

/**
 * Provides a programmatic screen-reader announcement API via context.
 * Place <AnnouncerProvider> near the root of the app, then call `useAnnouncer()`
 * anywhere to imperatively announce status changes.
 *
 * @example
 * const { announce } = useAnnouncer();
 * announce("File uploaded successfully");
 * announce("Error: request failed", "assertive");
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [politeMsg, setPoliteMsg] = useState("");
  const [assertiveMsg, setAssertiveMsg] = useState("");
  const politeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assertiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((message: string, politeness: "polite" | "assertive" = "polite") => {
    if (politeness === "assertive") {
      setAssertiveMsg("");
      if (assertiveTimer.current) clearTimeout(assertiveTimer.current);
      assertiveTimer.current = setTimeout(() => setAssertiveMsg(message), 50);
    } else {
      setPoliteMsg("");
      if (politeTimer.current) clearTimeout(politeTimer.current);
      politeTimer.current = setTimeout(() => setPoliteMsg(message), 50);
    }
  }, []);

  const srStyle: React.CSSProperties = {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0,0,0,0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  };

  return (
    <AnnouncerContext.Provider value={{ announce }}>
      {children}
      <div aria-live="polite" aria-atomic="true" style={srStyle}>
        {politeMsg}
      </div>
      <div aria-live="assertive" aria-atomic="true" style={srStyle}>
        {assertiveMsg}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnouncer() {
  const ctx = useContext(AnnouncerContext);
  if (!ctx) throw new Error("useAnnouncer must be used within <AnnouncerProvider>");
  return ctx;
}
