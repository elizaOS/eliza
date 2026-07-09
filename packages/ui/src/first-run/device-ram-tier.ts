/**
 * Pure RAM-tier classification for the mobile runtime policy (#14390): which
 * runtime options a phone may be offered, keyed on marketed RAM size.
 *
 * Low-RAM phones cannot sustain the on-device agent — a 4 GB Moto G Play
 * wedges boot for the full 180 s startup budget — so the policy is RAM-driven,
 * not build-driven: under 8 GB the local agent is disabled outright (cloud
 * only); under 12 GB the agent may run but on-device models are disabled
 * (cloud-inference only); under 16 GB on-device models are allowed with a
 * performance/thermal warning; 16 GB and up is unrestricted.
 *
 * The OS under-reports marketed capacity (kernel/carveout reserve a slice: a
 * "4 GB" device reads ~3.6 GiB, an "8 GB" one ~7.2-7.6 GiB), so raw readings
 * are rounded UP to the next whole GB to recover the marketed size before the
 * thresholds apply. The Android service-side gate mirrors this conversion in
 * `DeviceRamTierPolicy.java`; keep the two in sync.
 *
 * Everything here is pure — probing the device and enforcing the policy live
 * in `device-ram-gate.ts`.
 */

export type DeviceRamTier =
  | "cloud-only"
  | "no-local-models"
  | "local-models-warn"
  | "full-local"
  | "unknown";

export interface DeviceRamTierAssessment {
  tier: DeviceRamTier;
  /** Marketed RAM size in GB, or null when the device total is unreadable. */
  marketedRamGb: number | null;
  /** May this device run the on-device agent at all (>= 8 GB)? */
  allowsLocalAgent: boolean;
  /** May this device download/run on-device models (>= 12 GB)? */
  allowsLocalModels: boolean;
  /** On-device models allowed but sub-16 GB: warn about perf/thermal/battery. */
  localModelsWarning: boolean;
  /** Short human line explaining the classification, for chat turns/labels. */
  reason: string;
}

export const LOCAL_AGENT_MIN_MARKETED_RAM_GB = 8;
export const LOCAL_MODELS_MIN_MARKETED_RAM_GB = 12;
export const LOCAL_MODELS_WARN_BELOW_MARKETED_RAM_GB = 16;

/**
 * Recover the marketed RAM size (whole GB) from a raw device total in MB.
 * Rounds UP so kernel-reserved slices don't demote a device a whole tier
 * (a Moto G Play "4 GB" reads ~3660 MB → 4; a Pixel "8 GB" ~7500 MB → 8).
 * Invalid/unreadable input is null — never a fabricated size.
 */
export function marketedRamGbFromTotalRamMb(
  totalRamMb: number | null | undefined,
): number | null {
  if (
    typeof totalRamMb !== "number" ||
    !Number.isFinite(totalRamMb) ||
    totalRamMb <= 0
  ) {
    return null;
  }
  return Math.ceil(totalRamMb / 1024);
}

/**
 * Classify a marketed RAM size into the runtime-policy tier. `null` (RAM
 * unreadable, or a platform the mobile policy does not govern) classifies as
 * "unknown" and gates nothing: the only consumer of an unknown tier is an
 * explicit user choice, which a probe failure must not brick — the distinct
 * tier keeps that decision visible rather than fabricating a capable device.
 */
export function classifyDeviceRamTier(
  marketedRamGb: number | null,
  // Curated devices (the LP3) that clear the on-device-agent floor by allowlist
  // rather than by raw RAM — mirrors the native
  // ElizaAgentService.isLocalAgentRamFloorExemptDevice via the ElizaNative
  // bridge. Lifts ONLY the local-agent floor (hybrid/cloud-inference runs with
  // no local model mmap); the 12 GB local-MODELS floor still applies normally.
  ramFloorExempt = false,
): DeviceRamTierAssessment {
  if (marketedRamGb === null || !Number.isFinite(marketedRamGb)) {
    return {
      tier: "unknown",
      marketedRamGb: null,
      allowsLocalAgent: true,
      allowsLocalModels: true,
      localModelsWarning: false,
      reason: "device memory could not be determined",
    };
  }
  if (marketedRamGb < LOCAL_AGENT_MIN_MARKETED_RAM_GB && !ramFloorExempt) {
    return {
      tier: "cloud-only",
      marketedRamGb,
      allowsLocalAgent: false,
      allowsLocalModels: false,
      localModelsWarning: false,
      reason: `this device has ~${marketedRamGb} GB RAM and the on-device agent needs ${LOCAL_AGENT_MIN_MARKETED_RAM_GB} GB or more`,
    };
  }
  if (marketedRamGb < LOCAL_MODELS_MIN_MARKETED_RAM_GB) {
    return {
      tier: "no-local-models",
      marketedRamGb,
      allowsLocalAgent: true,
      allowsLocalModels: false,
      localModelsWarning: false,
      reason: `this device has ~${marketedRamGb} GB RAM and on-device models need ${LOCAL_MODELS_MIN_MARKETED_RAM_GB} GB or more`,
    };
  }
  if (marketedRamGb < LOCAL_MODELS_WARN_BELOW_MARKETED_RAM_GB) {
    return {
      tier: "local-models-warn",
      marketedRamGb,
      allowsLocalAgent: true,
      allowsLocalModels: true,
      localModelsWarning: true,
      reason: `this device has ~${marketedRamGb} GB RAM — on-device models will work but can be slow and run warm (${LOCAL_MODELS_WARN_BELOW_MARKETED_RAM_GB} GB recommended)`,
    };
  }
  return {
    tier: "full-local",
    marketedRamGb,
    allowsLocalAgent: true,
    allowsLocalModels: true,
    localModelsWarning: false,
    reason: `this device has ~${marketedRamGb} GB RAM`,
  };
}
