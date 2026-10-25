/**
 * Coarse interval-updated "current time" hook for recency/decay UI, kept off the
 * render path to satisfy the determinism convention (see block below).
 */
import { useEffect, useState } from "react";

/**
 * A coarse "current time" (epoch-ms) that updates on an interval, for recency /
 * decay math that must re-render as time passes (e.g. home-widget attention
 * decay). Returns `0` on the first render so that render path stays
 * deterministic — `Date.now()` is never called during render (see the UI
 * determinism convention); the real clock is installed in an effect and then
 * ticks every `intervalMs`.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
