import nprogress from "nprogress";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

nprogress.configure({ showSpinner: false, trickleSpeed: 120, minimum: 0.15 });

/**
 * Drives the nprogress bar from react-router navigation.
 *
 * Strategy: when the location changes, start the bar and finish it shortly
 * after — the bar is a presence cue, not an in-flight indicator (the SPA
 * does its own data fetching with TanStack Query). The previous version
 * had `[]` deps and only fired once; this version reacts to every
 * navigation.
 */
export function NavigationProgress() {
  const { pathname, search } = useLocation();
  const isFirstRender = useRef(true);
  const timerRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname/search are intentional triggers — each navigation should restart the bar
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    nprogress.start();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      nprogress.done();
      timerRef.current = null;
    }, 200);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      nprogress.done();
    };
  }, [pathname, search]);

  return null;
}
