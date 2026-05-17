"use client";

import { useCallback, useRef, useState } from "react";

/** Default milliseconds to show copy-success feedback before resetting. */
const DEFAULT_DURATION_MS = 2000;

export interface UseCopyFeedbackResult {
  /** True while the "copied" state is active. */
  copied: boolean;
  /** Call this after a successful copy to trigger the feedback. */
  markCopied: () => void;
}

/**
 * Tracks transient "copied" feedback state.
 *
 * Multiple components across the dashboard implement the same pattern:
 *   const [copied, setCopied] = useState(false);
 *   const timerRef = useRef<…>();
 *   // … setCopied(true); clearTimeout(timerRef.current); timerRef = setTimeout(() => setCopied(false), N)
 *
 * This hook encapsulates that logic. It clears any pending timer on each call
 * to `markCopied` so rapid successive copies don't leave stale state.
 */
export function useCopyFeedback(
  durationMs: number = DEFAULT_DURATION_MS,
): UseCopyFeedbackResult {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markCopied = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    setCopied(true);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  return { copied, markCopied };
}
