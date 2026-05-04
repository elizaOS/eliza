import { useRef } from "react";

const THRESHOLD = 3;
const WINDOW_MS = 1000;
const IS_DEV =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");

/**
 * Development-only render-rate guard.
 *
 * Tracks render timestamps for the named component and logs a console warning
 * when the component re-renders {@link THRESHOLD} or more times within
 * {@link WINDOW_MS} ms.  No-op in production builds.
 *
 * Usage:
 * ```ts
 * function MyComponent() {
 *   useRenderGuard("MyComponent");
 *   // …
 * }
 * ```
 */
export function useRenderGuard(name: string): void {
  // Always call the hook (preserve hook call order) but skip work in prod.
  const timestamps = useRef<number[]>([]);
  if (!IS_DEV) return;

  const now = Date.now();
  const ts = timestamps.current;
  ts.push(now);

  // Prune old entries outside the window
  while (ts.length > 0 && ts[0] < now - WINDOW_MS) {
    ts.shift();
  }

  if (ts.length >= THRESHOLD) {
    console.warn(
      `[RenderGuard] "${name}" rendered ${ts.length}× in the last ${WINDOW_MS}ms`,
    );
  }
}
