import {
  type CompanionHalfFramerateMode,
  type CompanionVrmPowerMode,
  type DesktopPowerState,
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "@elizaos/ui";

/** How often to re-read AC vs battery in the Electrobun shell (ms). */
export const VRM_DESKTOP_BATTERY_POLL_MS = 60_000;

/**
 * localStorage: set to **`"0"`** to keep full Retina VRM resolution on battery.
 *
 * **WHY:** some users prefer visual fidelity over the default **1×** pixel cap
 * when unplugged.
 */
export const VRM_BATTERY_PIXEL_CAP_STORAGE_KEY = "eliza.vrmBatteryPixelCap";

export function isVrmBatteryPixelCapEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return (
      window.localStorage.getItem(VRM_BATTERY_PIXEL_CAP_STORAGE_KEY) !== "0"
    );
  } catch {
    return true;
  }
}

export type VrmEngineBatteryPolicyTarget = {
  isInitialized(): boolean;
  /** DPR cap + shadow + Spark tuning — independent of frame cadence. */
  setLowPowerRenderMode(enabled: boolean): void;
  /** ~Half display refresh: skip alternate ticks; uses `Clock` accumulation. */
  setHalfFramerateMode(enabled: boolean): void;
};

export type RefreshVrmDesktopBatteryPixelPolicyOptions = {
  /** User Settings: quality / balanced / efficiency (default `balanced`). */
  companionVrmPowerMode?: CompanionVrmPowerMode;
  /**
   * When to apply half-FPS: never, whenever pixel low-power is active, or always.
   * Default `when_saving_power` matches historic “bundled” behavior.
   */
  companionHalfFramerateMode?: CompanionHalfFramerateMode;
};

function resolveHalfFramerateEnabled(
  halfMode: CompanionHalfFramerateMode,
  lowPowerVisual: boolean,
): boolean {
  if (halfMode === "off") return false;
  if (halfMode === "always") return true;
  return lowPowerVisual;
}

/**
 * Syncs **`VrmEngine`** **pixel / shadow / Spark** policy and **half-FPS** from
 * **`desktop:getPowerState`** (Electrobun) and **`companionVrmPowerMode`**.
 *
 * - **`quality`:** never low-power visuals.
 * - **`efficiency`:** always low-power visuals.
 * - **`balanced`:** low-power visuals only when on battery and the battery pixel cap path is active.
 *
 * Half-FPS follows **`companionHalfFramerateMode`**: default ties it to the same
 * moments as low-power visuals (`when_saving_power`).
 */
export async function refreshVrmDesktopBatteryPixelPolicy(
  engine: VrmEngineBatteryPolicyTarget | null,
  options?: RefreshVrmDesktopBatteryPixelPolicyOptions,
): Promise<void> {
  const mode = options?.companionVrmPowerMode ?? "balanced";
  const halfMode = options?.companionHalfFramerateMode ?? "when_saving_power";
  if (!engine?.isInitialized()) return;

  let lowPowerVisual: boolean;

  if (!isElectrobunRuntime()) {
    lowPowerVisual = mode === "efficiency";
    engine.setLowPowerRenderMode(lowPowerVisual);
    engine.setHalfFramerateMode(
      resolveHalfFramerateEnabled(halfMode, lowPowerVisual),
    );
    return;
  }
  if (!isVrmBatteryPixelCapEnabled()) {
    lowPowerVisual = mode === "efficiency";
    engine.setLowPowerRenderMode(lowPowerVisual);
    engine.setHalfFramerateMode(
      resolveHalfFramerateEnabled(halfMode, lowPowerVisual),
    );
    return;
  }
  const power = await invokeDesktopBridgeRequest<DesktopPowerState>({
    rpcMethod: "desktopGetPowerState",
    ipcChannel: "desktop:getPowerState",
  });
  if (!power) return;
  if (mode === "quality") {
    lowPowerVisual = false;
  } else if (mode === "efficiency") {
    lowPowerVisual = true;
  } else {
    lowPowerVisual = power.onBattery === true;
  }
  engine.setLowPowerRenderMode(lowPowerVisual);
  engine.setHalfFramerateMode(
    resolveHalfFramerateEnabled(halfMode, lowPowerVisual),
  );
}
