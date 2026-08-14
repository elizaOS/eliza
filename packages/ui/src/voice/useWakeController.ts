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
 * Two native wake signals are bridged: the Swabble plugin's `wakeWord` event
 * (Web-Speech fallback path) and the fused on-device openWakeWord runtime via
 * {@link subscribeFusedWake} (head-fire / Stage-A candidate / Stage-B transcript
 * stages). Both route through the same reducer dispatch, so the controller picks
 * the cheapest available path per `capabilities` with no UI change. The hook
 * never invents a subscription for a detector that is not actually present.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import * as React from "react";
import {
  getSwabblePlugin,
  type SwabbleConfig,
  type SwabbleWakeWordEvent,
} from "../bridge/native-plugins";
import {
  type FusedWakeEvent,
  probeFusedWake,
  subscribeFusedWake,
} from "./fused-wake-bridge";
import {
  isDesktopFusedWakeListening,
  startDesktopFusedWake,
  stopDesktopFusedWake,
} from "./fused-wake-desktop-bridge";
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
import { normalizeForWake, type WakeNameMatchOptions } from "./wake-name-match";

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
  /**
   * Fused-wake subscription source (injectable for tests). Defaults to the
   * renderer {@link subscribeFusedWake} bridge. Only consulted when the resolved
   * capabilities declare `openWakeWord`.
   */
  fusedWakeSource?: (listener: (event: FusedWakeEvent) => void) => () => void;
  /** Native fused detector lifecycle (injectable for deterministic tests). */
  fusedLifecycle?: FusedWakeLifecycle;
  /** Persisted Swabble config source used when the plugin has no live config. */
  swabbleConfigSource?: () => Promise<Partial<SwabbleConfig> | null>;
}

export interface FusedWakeLifecycle {
  isListening(): Promise<boolean | null>;
  start(head: string): Promise<{ started: boolean; reason?: string }>;
  stop(): Promise<void>;
}

export interface WakeControllerHandle {
  /** The selected detection path, or null when no detector is available. */
  path: WakeDetectionPath | null;
  /** The resolved capabilities used for selection. */
  capabilities: WakeCapabilities;
}

/** True when the Swabble native plugin is actually present on this platform. */
function probeSwabble(): boolean {
  const plugin = getSwabblePlugin() as Record<string, unknown>;
  return (
    typeof plugin.addListener === "function" &&
    typeof plugin.getConfig === "function" &&
    typeof plugin.isListening === "function" &&
    typeof plugin.start === "function" &&
    typeof plugin.stop === "function"
  );
}

const DESKTOP_FUSED_LIFECYCLE: FusedWakeLifecycle = {
  isListening: isDesktopFusedWakeListening,
  start: startDesktopFusedWake,
  stop: stopDesktopFusedWake,
};

const NO_PERSISTED_SWABBLE_CONFIG = async (): Promise<null> => null;

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

const SWABBLE_MODEL_SIZES = new Set<NonNullable<SwabbleConfig["modelSize"]>>([
  "tiny",
  "base",
  "small",
  "medium",
  "large",
]);

/** Build a character-aware config without discarding user-customized fields. */
export function buildWakeSwabbleConfig(
  characterName: string,
  pluginConfig?: Partial<SwabbleConfig> | null,
  persistedConfig?: Partial<SwabbleConfig> | null,
): SwabbleConfig {
  const derivedTrigger = normalizeForWake(characterName) || "eliza";
  const source = { ...(persistedConfig ?? {}), ...(pluginConfig ?? {}) };
  const configuredTriggers = Array.isArray(source.triggers)
    ? source.triggers
        .filter((trigger): trigger is string => typeof trigger === "string")
        .map(normalizeForWake)
        .filter(Boolean)
    : [];
  const triggers = Array.from(
    new Set(
      configuredTriggers.includes(derivedTrigger)
        ? configuredTriggers
        : configuredTriggers.length === 1 && configuredTriggers[0] === "eliza"
          ? [derivedTrigger]
          : [derivedTrigger, ...configuredTriggers],
    ),
  );

  const config: SwabbleConfig = { triggers };
  const minPostTriggerGap = readPositiveNumber(source.minPostTriggerGap);
  if (minPostTriggerGap !== undefined)
    config.minPostTriggerGap = minPostTriggerGap;
  const minCommandLength = readPositiveNumber(source.minCommandLength);
  if (minCommandLength !== undefined)
    config.minCommandLength = minCommandLength;
  const sampleRate = readPositiveNumber(source.sampleRate);
  if (sampleRate !== undefined) config.sampleRate = sampleRate;
  if (typeof source.locale === "string" && source.locale.trim()) {
    config.locale = source.locale.trim();
  }
  if (
    source.modelSize &&
    SWABBLE_MODEL_SIZES.has(
      source.modelSize as NonNullable<SwabbleConfig["modelSize"]>,
    )
  ) {
    config.modelSize = source.modelSize;
  }
  return config;
}

function fusedHeadForCharacter(characterName: string): string {
  const normalized = normalizeForWake(characterName) || "eliza";
  return `hey-${normalized.replace(/\s+/gu, "-")}`;
}

async function stopOwnedDetector(
  detector: "fused" | "swabble",
  stop: () => Promise<void>,
): Promise<void> {
  try {
    await stop();
  } catch (error) {
    // error-policy:J6 detector teardown is best-effort after ownership ends.
    logger.warn({ error, detector }, "[wake-controller] detector stop failed");
  }
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
    fusedWakeSource = subscribeFusedWake,
    fusedLifecycle = DESKTOP_FUSED_LIFECYCLE,
    swabbleConfigSource = NO_PERSISTED_SWABBLE_CONFIG,
  } = options;

  // Probe the available wake sources once. The fused on-device path is preferred
  // when the native host has bridged it (window.__ELIZA_FUSED_WAKE__); Swabble is
  // the Web-Speech fallback. A host can still override `capabilities` explicitly.
  const swabblePresent = React.useMemo(() => probeSwabble(), []);
  const fusedPresent = React.useMemo(() => probeFusedWake(), []);
  const declaredCapabilities = React.useMemo<WakeCapabilities>(
    () =>
      options.capabilities ?? {
        openWakeWord: fusedPresent,
        asrConfirm: fusedPresent,
        swabble: swabblePresent,
      },
    [
      options.capabilities,
      options.capabilities?.openWakeWord,
      options.capabilities?.asrConfirm,
      options.capabilities?.swabble,
      fusedPresent,
      swabblePresent,
    ],
  );
  const fusedLifecycleKey = JSON.stringify([
    enabled,
    alwaysOn,
    characterName,
    declaredCapabilities.openWakeWord,
    declaredCapabilities.asrConfirm,
  ]);
  const [failedFusedLifecycleKey, setFailedFusedLifecycleKey] = React.useState<
    string | null
  >(null);
  const fusedUnavailable = failedFusedLifecycleKey === fusedLifecycleKey;
  React.useEffect(() => {
    if (!enabled || alwaysOn) setFailedFusedLifecycleKey(null);
  }, [enabled, alwaysOn]);
  const capabilities = React.useMemo<WakeCapabilities>(
    () =>
      fusedUnavailable
        ? {
            openWakeWord: false,
            asrConfirm: false,
            swabble: declaredCapabilities.swabble,
          }
        : declaredCapabilities,
    [declaredCapabilities, fusedUnavailable],
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
  const swabbleOperationRef = React.useRef<Promise<void>>(Promise.resolve());
  const fusedOperationRef = React.useRef<Promise<void>>(Promise.resolve());

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

  // The selected Swabble fallback owns both its listener and microphone
  // lifecycle. Listener registration completes before start so a fast native
  // fire cannot be missed. Operations serialize across React cleanup/restart,
  // preventing a late old start from stopping a newer lifecycle.
  React.useEffect(() => {
    if (!enabled || alwaysOn || path !== "swabble-fallback") return;
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    let armed = false;
    let ownsLifecycle = false;
    const plugin = getSwabblePlugin();
    const operation = swabbleOperationRef.current.then(async () => {
      try {
        const h = await plugin.addListener(
          "wakeWord",
          (event?: SwabbleWakeWordEvent) => {
            if (!armed || cancelled) return;
            dispatch({
              type: "swabble-wake",
              wakeWord: event?.wakeWord ?? configRef.current.characterName,
              command: event?.command ?? "",
              transcript: event?.transcript ?? event?.wakeWord ?? "",
              confidence: event?.confidence,
            });
          },
        );
        if (cancelled) {
          await stopOwnedDetector("swabble", () => h.remove());
          return;
        }
        handle = h;

        const { listening } = await plugin.isListening();
        if (cancelled) return;
        if (listening) {
          armed = true;
          return;
        }

        let pluginConfig: Partial<SwabbleConfig> | null = null;
        try {
          pluginConfig = (await plugin.getConfig()).config;
        } catch {
          // error-policy:J4 a missing live config falls back to the persisted
          // config and never fabricates an active detector.
        }
        const persistedConfig = await swabbleConfigSource();
        if (cancelled) return;
        const result = await plugin.start({
          config: buildWakeSwabbleConfig(
            characterName,
            pluginConfig,
            persistedConfig,
          ),
        });
        if (!result.started) return;
        if (cancelled) {
          await stopOwnedDetector("swabble", () => plugin.stop());
          return;
        }
        ownsLifecycle = true;
        armed = true;
      } catch (error) {
        // error-policy:J4 wake-word plugin unavailable on this platform — the
        // opt-in feature fails closed and never treats a listener as armed.
        logger.warn({ error }, "[wake-controller] Swabble start unavailable");
      }
    });
    swabbleOperationRef.current = operation;
    return () => {
      cancelled = true;
      armed = false;
      if (handle) {
        const listenerHandle = handle;
        void stopOwnedDetector("swabble", () => listenerHandle.remove());
        handle = null;
      }
      const cleanupOperation = swabbleOperationRef.current.then(async () => {
        if (!ownsLifecycle) return;
        ownsLifecycle = false;
        await stopOwnedDetector("swabble", () => plugin.stop());
      });
      swabbleOperationRef.current = cleanupOperation;
    };
  }, [enabled, alwaysOn, path, characterName, dispatch, swabbleConfigSource]);

  const fusedSourceRef = React.useRef(fusedWakeSource);
  fusedSourceRef.current = fusedWakeSource;

  // The preferred fused detector is also opt-in and lifecycle-owned here. When
  // its model/bridge cannot start, capability selection falls back to Swabble
  // for this enablement rather than leaving a dead preferred path selected.
  React.useEffect(() => {
    if (
      !enabled ||
      alwaysOn ||
      (path !== "head-fast-path" && path !== "two-stage-asr")
    )
      return;
    let cancelled = false;
    let armed = false;
    let ownsLifecycle = false;
    const unsubscribe = fusedSourceRef.current((event) => {
      if (!armed || cancelled) return;
      if (event.stage === "head-fired") {
        dispatch({
          type: "head-fired",
          confidence: event.confidence,
          now: nowRef.current(),
        });
      } else if (event.stage === "stage-a-candidate") {
        dispatch({ type: "stage-a-candidate", now: nowRef.current() });
      } else {
        dispatch({
          type: "stage-b-transcript",
          transcript: event.transcript ?? "",
          now: nowRef.current(),
        });
      }
    });
    const operation = fusedOperationRef.current.then(async () => {
      try {
        const listening = await fusedLifecycle.isListening();
        if (cancelled) return;
        if (listening === true) {
          armed = true;
          return;
        }
        if (listening === null) {
          setFailedFusedLifecycleKey(fusedLifecycleKey);
          return;
        }
        const result = await fusedLifecycle.start(
          fusedHeadForCharacter(characterName),
        );
        if (!result.started) {
          if (!cancelled) setFailedFusedLifecycleKey(fusedLifecycleKey);
          return;
        }
        if (cancelled) {
          await stopOwnedDetector("fused", () => fusedLifecycle.stop());
          return;
        }
        ownsLifecycle = true;
        armed = true;
      } catch (error) {
        // error-policy:J4 an unavailable native detector fails closed and lets
        // the declared Swabble capability become the selected fallback.
        logger.warn(
          { error },
          "[wake-controller] fused wake start unavailable",
        );
        if (!cancelled) setFailedFusedLifecycleKey(fusedLifecycleKey);
      }
    });
    fusedOperationRef.current = operation;
    return () => {
      cancelled = true;
      armed = false;
      unsubscribe();
      const cleanupOperation = fusedOperationRef.current.then(async () => {
        if (!ownsLifecycle) return;
        ownsLifecycle = false;
        await stopOwnedDetector("fused", () => fusedLifecycle.stop());
      });
      fusedOperationRef.current = cleanupOperation;
    };
  }, [
    enabled,
    alwaysOn,
    path,
    characterName,
    dispatch,
    fusedLifecycle,
    fusedLifecycleKey,
  ]);

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
