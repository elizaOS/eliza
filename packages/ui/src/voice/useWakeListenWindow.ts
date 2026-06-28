/**
 * React adapter for the wake-word listening window.
 *
 * Subscribes to the native Swabble `wakeWord` event, drives the pure
 * {@link wakeWindowReducer} with a low-frequency tick, and mirrors
 * `micShouldBeOpen` onto the host's hands-free mic via `onOpen` / `onClose`.
 *
 * It is intentionally a thin shell: all the rules (open on wake, close on
 * response, idle-timeout, safety cap, re-arm) live in the pure module and are
 * unit-tested there. This hook only owns the side effects (event subscription,
 * timer, callbacks) and the "don't fight always-on" guard.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import * as React from "react";
import { getSwabblePlugin } from "../bridge/native-plugins";
import {
  DEFAULT_WAKE_WINDOW_CONFIG,
  initialWakeWindowState,
  micShouldBeOpen,
  type WakeWindowConfig,
  type WakeWindowEvent,
  type WakeWindowState,
  wakeWindowReducer,
} from "./wake-listen-window";

export interface UseWakeListenWindowOptions {
  /**
   * Master switch — the user's wake-word setting. When false the hook does
   * nothing (no subscription, no mic effect).
   */
  enabled: boolean;
  /**
   * True when the user has already chosen always-on (or the mic is otherwise
   * persistently open). Wake is only an entry ramp, so while this is true the
   * hook stays inert and never opens/closes the mic out from under the user.
   */
  alwaysOn: boolean;
  /**
   * Level signal: true while the agent is busy with the turn (generating or
   * speaking). Its RISING edge means the user's utterance was submitted (→
   * await the reply); its FALLING edge means the agent responded (→ close the
   * window). Wire from `chatSending || voiceOutput.speaking`.
   */
  agentBusy: boolean;
  /** Open the hands-free mic (called when the window opens). */
  onOpen: () => void;
  /** Close the hands-free mic (called when the window closes). */
  onClose: () => void;
  config?: WakeWindowConfig;
  /** Tick interval ms (injectable for tests). Default 500. */
  tickMs?: number;
  /** Clock (injectable for tests). Default Date.now. */
  now?: () => number;
}

export function useWakeListenWindow(
  options: UseWakeListenWindowOptions,
): WakeWindowState {
  const {
    enabled,
    alwaysOn,
    agentBusy,
    onOpen,
    onClose,
    config = DEFAULT_WAKE_WINDOW_CONFIG,
    tickMs = 500,
    now = Date.now,
  } = options;

  const [state, setState] = React.useState<WakeWindowState>(
    initialWakeWindowState,
  );

  // Keep the latest callbacks/clock in refs so the long-lived subscription and
  // timer don't need to re-bind on every render.
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const nowRef = React.useRef(now);
  nowRef.current = now;
  const configRef = React.useRef(config);
  configRef.current = config;

  const dispatch = React.useCallback((event: WakeWindowEvent) => {
    setState((prev) => wakeWindowReducer(prev, event, configRef.current));
  }, []);

  // Mirror the desired mic state onto the host whenever the phase changes.
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    const open = micShouldBeOpen(state);
    if (open && !wasOpenRef.current) onOpenRef.current();
    else if (!open && wasOpenRef.current) onCloseRef.current();
    wasOpenRef.current = open;
  }, [state]);

  // While always-on (or disabled), the window must not be holding the mic.
  React.useEffect(() => {
    if ((!enabled || alwaysOn) && state.phase !== "idle") {
      dispatch({ type: "reset" });
    }
  }, [enabled, alwaysOn, state.phase, dispatch]);

  // Subscribe to native wake detections.
  React.useEffect(() => {
    if (!enabled || alwaysOn) return;
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const h = await getSwabblePlugin().addListener("wakeWord", () => {
          dispatch({ type: "wake", now: nowRef.current() });
        });
        if (cancelled) void h.remove();
        else handle = h;
      } catch {
        // Plugin unavailable on this platform — wake never fires, no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [enabled, alwaysOn, dispatch]);

  // Derive the user/agent edges from the agentBusy level: rising = the turn was
  // submitted (user spoke), falling = the agent finished responding.
  const prevBusyRef = React.useRef(false);
  React.useEffect(() => {
    const prev = prevBusyRef.current;
    prevBusyRef.current = agentBusy;
    if (agentBusy && !prev) {
      dispatch({ type: "user-speech-final", now: nowRef.current() });
    } else if (!agentBusy && prev) {
      dispatch({ type: "agent-responded", now: nowRef.current() });
    }
  }, [agentBusy, dispatch]);

  // Tick the idle timeout / safety cap while a window is open.
  React.useEffect(() => {
    if (state.phase === "idle") return;
    const id = window.setInterval(() => {
      dispatch({ type: "tick", now: nowRef.current() });
    }, tickMs);
    return () => window.clearInterval(id);
  }, [state.phase, tickMs, dispatch]);

  return state;
}
