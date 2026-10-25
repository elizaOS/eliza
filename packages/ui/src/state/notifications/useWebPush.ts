/**
 * React hook wrapping the web-push subscription manager. Surfaces the coarse
 * {@link WebPushState}, a busy flag, and gesture-safe `subscribe`/`unsubscribe`
 * actions for the settings toggle. Re-probes state on mount and on window focus
 * so an OS-level permission change (Settings app) reflects without a reload.
 *
 * The subscribe action MUST be invoked directly from a user-gesture handler
 * (button onClick) — it calls `Notification.requestPermission()` + `subscribe`
 * synchronously in the same task, which iOS requires.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultWebPushDeps,
  getWebPushState,
  subscribeWebPush,
  unsubscribeWebPush,
  type WebPushDeps,
  type WebPushState,
} from "./web-push-subscription";

export interface UseWebPushResult {
  state: WebPushState;
  busy: boolean;
  error: string | null;
  /** True once the first state probe has resolved. */
  ready: boolean;
  /** Prompt + subscribe. Call from a user-gesture handler. */
  subscribe: () => Promise<void>;
  /** Tear down the subscription. */
  unsubscribe: () => Promise<void>;
  /** Re-probe the current state (e.g. after returning from OS settings). */
  refresh: () => Promise<void>;
}

export function useWebPush(
  deps: WebPushDeps = defaultWebPushDeps,
): UseWebPushResult {
  const [state, setState] = useState<WebPushState>("unsupported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getWebPushState(deps);
      if (mountedRef.current) {
        setError(null);
        setState(next);
        setReady(true);
      }
    } catch (_error) {
      // error-policy:J4 settings must distinguish push-probe failures from unsupported/empty states.
      if (mountedRef.current) {
        setError("Could not read push notification settings.");
        setReady(true);
      }
    }
  }, [deps]);

  const runMutation = useCallback(
    async (operation: () => Promise<WebPushState>) => {
      if (mountedRef.current) {
        setBusy(true);
        setError(null);
      }
      try {
        const next = await operation();
        if (mountedRef.current) setState(next);
      } catch (_error) {
        // error-policy:J4 settings must render failed subscribe/unsubscribe operations explicitly.
        if (mountedRef.current) {
          setError("Could not update push notifications. Try again.");
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [],
  );

  const subscribe = useCallback(async () => {
    await runMutation(async () => {
      const { state: next } = await subscribeWebPush(deps);
      return next;
    });
  }, [deps, runMutation]);

  const unsubscribe = useCallback(async () => {
    await runMutation(() => unsubscribeWebPush(deps));
  }, [deps, runMutation]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const onFocus = () => void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      mountedRef.current = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, [refresh]);

  return { state, busy, error, ready, subscribe, unsubscribe, refresh };
}
