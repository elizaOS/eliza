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
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getWebPushState(deps);
    if (mountedRef.current) {
      setState(next);
      setReady(true);
    }
  }, [deps]);

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

  const subscribe = useCallback(async () => {
    if (mountedRef.current) setBusy(true);
    try {
      const { state: next } = await subscribeWebPush(deps);
      if (mountedRef.current) setState(next);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [deps]);

  const unsubscribe = useCallback(async () => {
    if (mountedRef.current) setBusy(true);
    try {
      const next = await unsubscribeWebPush(deps);
      if (mountedRef.current) setState(next);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [deps]);

  return { state, busy, ready, subscribe, unsubscribe, refresh };
}
