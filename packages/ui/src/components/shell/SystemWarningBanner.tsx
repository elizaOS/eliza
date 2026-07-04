import { useEffect, useRef } from "react";
import { useAppSelector } from "../../state";
import { TOAST_TTL_MS } from "../../state/action-notice";
import { Button } from "../ui/button";

// z-[9998] mirrors Z_SYSTEM_BANNER in ../../lib/floating-layers.ts.
// Kept as a literal so Tailwind v4's source scanner emits the utility.

const AUTO_DISMISS_MS = TOAST_TTL_MS.systemWarning;

/**
 * Renders yellow warning banners for system-level warnings
 * broadcast via WebSocket `system-warning` events.
 */
export function SystemWarningBanner() {
  const systemWarnings = useAppSelector((s) => s.systemWarnings);
  const dismissSystemWarning = useAppSelector((s) => s.dismissSystemWarning);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    if (!systemWarnings?.length) return;
    const timers = timersRef.current;
    for (const message of systemWarnings) {
      if (!timers.has(message)) {
        const timer = setTimeout(() => {
          timers.delete(message);
          dismissSystemWarning(message);
        }, AUTO_DISMISS_MS);
        timers.set(message, timer);
      }
    }
    for (const [msg, timer] of timers) {
      if (!systemWarnings.includes(msg)) {
        clearTimeout(timer);
        timers.delete(msg);
      }
    }
  }, [systemWarnings, dismissSystemWarning]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  if (!systemWarnings?.length) return null;

  return (
    <>
      {systemWarnings.map((message) => (
        <div
          key={message}
          role="alert"
          aria-live="assertive"
          data-window-titlebar-banner="true"
          // bg-warn (--warn: #ff8a24) is a light-ish orange in every theme, so
          // the theme-flipping --accent-foreground (white here) fails WCAG
          // contrast (~2.4:1). Pin the foreground to near-black for ~8:1.
          className="mobile-top-banner shrink-0 z-[9998] flex items-center justify-between gap-3 bg-warn px-4 py-2 text-sm font-medium text-[color:var(--brand-black)] "
        >
          <span className="truncate">{message}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dismissSystemWarning(message)}
            className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-[color:var(--brand-black)]/80 hover:bg-black/10"
          >
            x
          </Button>
        </div>
      ))}
    </>
  );
}
