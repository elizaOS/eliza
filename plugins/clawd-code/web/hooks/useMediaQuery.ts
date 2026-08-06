"use client";

import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** < 768px */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** 768px – 1023px */
export function useIsTablet(): boolean {
  return useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
}

/** >= 1024px */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
