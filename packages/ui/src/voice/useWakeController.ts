/**
 * React adapter for the unified wake controller (issue #9880, §D).
 *
 * Selects the detection path for the current platform capabilities + character
 * name, owns the single native wake subscription, routes every detection through
 * the pure {@link wakeControllerReducer}, and surfaces each confirmed
 * {@link WakeDetection} via `onWake`. All the path/confirmation rules live in the
 * pure module and are unit + fuzz tested there; this hook only owns the side
 * effects (capability probe, event subscription, confirm-window tick).
 *
 * Today the only native wake signal bridged to the UI is the Swabble plugin's
 * `wakeWord` event, so the live path is `swabble-fallback`. When a host bridges
 * the fused openWakeWord Stage-A / head-fire events it declares them via
 * `capabilities`, and the same controller drives the battery-efficient path with
 * no change here. The hook never invents a subscription for a detector that is
 * not actually present.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import * as React from "react";
import {
  getSwabblePlugin,
  type SwabbleWakeWordEvent,
} from "../bridge/native-plugins";
import {
  DEFAULT_CONFIRM_WINDOW_MS,
  initialWakeControllerState,
  selectWakePath,
  type WakeCapabilities,
  type WakeControllerConfig,
  type WakeControllerEvent,
  type WakeControllerState,
  type WakeDetection,
  type WakeDetectionPath,
  wakeControllerReducer,
} from "./wake-controller";
import type { WakeNameMatchOptions } from "./wake-name-match";

/**
 * Character names that ship with a trained openWakeWord head (enabling the head
 * fast-path). Mirrors the voice catalog's `hey-eliza` head; auto-trained heads
 * are added as they land. Only consulted when a host declares `openWakeWord`.
 */
export const SHIPPED_WAKE_HEADS: ReadonlySet<string> = new Set(["eliza"]);

export interface UseWakeControllerOptions {
  /** Master switch — the user's wake-word setting. */
  enabled: boolean;
  /**
   * True when the mic is already persistently open (always-on). Wake is only an
   * entry ramp, so the controller stays inert and never fires while always-on.
   */
  alwaysOn: boolean;
  /** Live character name; the wake phrase is "hey <name>" / "<name>". */
  characterName: string;
  /** Called with each confirmed wake detection. */
  onWake: (detection: WakeDetection) => void;
  /**
   * Platform capabilities. Defaults to Swabble-only (the one wake source the UI
   * currently has bridged); a host that has wired the fused detector overrides.
   */
  capabilities?: WakeCapabilities;
  /** Names with a trained head. Default {@link SHIPPED_WAKE_HEADS}. */
  trainedHeads?: ReadonlySet<string>;
  confirmWindowMs?: number;
  nameMatch?: WakeNameMatchOptions;
  /** Confirm-window tick interval ms (injectable for tests). Default 500. */
  tickMs?: number;
  /** Clock (injectable for tests). Default Date.now. */
  now?: () => number;
}

export interface WakeControllerHandle {
  /** The selected detection path, or null when no detector is available. */
  path: WakeDetectionPath | null;
  /** The resolved capabilities used for selection. */
  capabilities: WakeCapabilities;
}

/** True when the Swabble native plugin is actually present on this platform. */
function probeSwabble(): boolean {
  const plugin = getSwabblePlugin() as { addListener?: unknown };
  return typeof plugin.addListener === "function";
}

export function useWakeController(
  options: UseWakeControllerOptions,
): WakeControllerHandle {
  const {
    enabled,
    alwaysOn,
    characterName,
    onWake,
    trainedHeads = SHIPPED_WAKE_HEADS,
    confirmWindowMs = DEFAULT_CONFIRM_WINDOW_MS,
    nameMatch,
    tickMs = 500,
    now = Date.now,
  } = options;

  // Probe Swabble once; the default capability set is Swabble-only because that
  // is the only wake source the UI has bridged today.
  const swabblePresent = React.useMemo(() => probeSwabble(), []);
  const capabilities = React.useMemo<WakeCapabilities>(
    () =>
      options.capabilities ?? {
        openWakeWord: false,
        asrConfirm: false,
        swabble: swabblePresent,
      },
    [options.capabilities, swabblePresent],
  );

  const config = React.useMemo<WakeControllerConfig>(
    () => ({
      characterName,
      trainedHeads,
      capabilities,
      confirmWindowMs,
      nameMatch,
    }),
    [characterName, trainedHeads, capabilities, confirmWindowMs, nameMatch],
  );
  const configRef = React.useRef(config);
  configRef.current = config;

  const path = React.useMemo(() => selectWakePath(config), [config]);

  const onWakeRef = React.useRef(onWake);
  onWakeRef.current = onWake;
  const nowRef = React.useRef(now);
  nowRef.current = now;

  const [phase, setPhase] =
    React.useState<WakeControllerState["phase"]>("idle");
  const stateRef = React.useRef<WakeControllerState>(
    initialWakeControllerState(),
  );

  const dispatch = React.useCallback((event: WakeControllerEvent) => {
    const step = wakeControllerReducer(
      stateRef.current,
      event,
      configRef.current,
    );
    stateRef.current = step.state;
    setPhase(step.state.phase);
    if (step.emit) onWakeRef.current(step.emit);
  }, []);

  // Reset when disabled or always-on takes over.
  React.useEffect(() => {
    if (!enabled || alwaysOn) dispatch({ type: "reset" });
  }, [enabled, alwaysOn, dispatch]);

  // Subscribe to the live native wake source (Swabble). When the fused detector
  // becomes bridged its Stage-A / head events route through the same dispatch.
  React.useEffect(() => {
    if (!enabled || alwaysOn || !capabilities.swabble) return;
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const h = await getSwabblePlugin().addListener(
          "wakeWord",
          (event?: SwabbleWakeWordEvent) => {
            dispatch({
              type: "swabble-wake",
              wakeWord: event?.wakeWord ?? configRef.current.characterName,
              command: event?.command ?? "",
              transcript: event?.transcript ?? event?.wakeWord ?? "",
              confidence: event?.confidence,
            });
          },
        );
        if (cancelled) void h.remove();
        else handle = h;
      } catch {
        // Plugin unavailable — wake never fires, no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [enabled, alwaysOn, capabilities.swabble, dispatch]);

  // Tick the Stage-B confirm-window timeout only while a candidate is armed.
  React.useEffect(() => {
    if (phase !== "confirming") return;
    const id = window.setInterval(() => {
      dispatch({ type: "tick", now: nowRef.current() });
    }, tickMs);
    return () => window.clearInterval(id);
  }, [phase, tickMs, dispatch]);

  return { path, capabilities };
}
