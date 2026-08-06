"use client";

import { useEffect, useState } from "react";

/**
 * Returns true when the user has requested reduced motion via OS settings.
 * Use this to disable or simplify animations for users who need it.
 *
 * @example
 * const reducedMotion = useReducedMotion();
 * <div className={reducedMotion ? "" : "animate-fade-in"}>...</div>
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reducedMotion;
}
