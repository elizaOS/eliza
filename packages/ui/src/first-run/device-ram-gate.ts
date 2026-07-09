/**
 * Device RAM-tier gate (#14390): probes the phone's total physical RAM through
 * the native bridges, classifies it (`device-ram-tier.ts`), and enforces the
 * policy at the two renderer seams that can commit a local runtime — the boot
 * path (a stale persisted "local" on a RAM-blocked device is reverted to
 * onboarding before startup resolves its target) and the first-run finish
 * (`first-run-finish.ts` calls `assertDeviceRamTierAllowsLocalRuntime` before
 * starting anything, so a disallowed mode fails loud instead of wedging).
 *
 * Probe order: the synchronous Android `ElizaNative.getDeviceTotalRamMb()`
 * JavascriptInterface first (available before the Capacitor plugin executor
 * and before any agent runs), then the async native resource snapshot
 * (`ResourceProbe`/`ElizaIntent.getResourceSnapshot`, which now carries
 * `totalRamMb`). Web/desktop are not governed by this policy — desktop has its
 * own device-tier system (`client-local-inference.ts`) — and classify as
 * "unknown" (gates nothing).
 *
 * The resolved assessment is cached for the session: total RAM cannot change
 * while the app runs, and the onboarding pick handlers need a synchronous
 * `peek` at decision time.
 */

import { logger } from "@elizaos/logger";
import { isAndroid, isIOS } from "../platform/init";
import { getDeviceResourceSnapshot } from "../services/local-inference/resource-snapshot-bridge";
import {
  classifyDeviceRamTier,
  type DeviceRamTierAssessment,
  marketedRamGbFromTotalRamMb,
} from "./device-ram-tier";
import { readPersistedMobileRuntimeMode } from "./mobile-runtime-mode";
import { clearPersistedLocalRuntimeCommitment } from "./revert-local-runtime-commitment";

interface ElizaNativeRamBridge {
  getDeviceTotalRamMb?: () => number;
}

/** The synchronous Android bridge read, or null off-Android / unavailable. */
function readSyncDeviceTotalRamMb(): number | null {
  try {
    const bridge = (
      globalThis as typeof globalThis & { ElizaNative?: ElizaNativeRamBridge }
    ).ElizaNative;
    const raw = bridge?.getDeviceTotalRamMb?.();
    // The bridge returns -1 for "unreadable" — never a fabricated zero.
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : null;
  } catch {
    // error-policy:J4 native-bridge probe — no sync bridge means this shell
    // doesn't expose it; the async snapshot probe still runs.
    return null;
  }
}

let cachedAssessment: DeviceRamTierAssessment | null = null;
let resolveInFlight: Promise<DeviceRamTierAssessment> | null = null;

/** Test seam: drop the session cache. */
export function resetDeviceRamGateForTests(): void {
  cachedAssessment = null;
  resolveInFlight = null;
}

/**
 * The already-known assessment, resolving the synchronous Android bridge on
 * first call; null while only the async probe could answer (iOS before
 * `resolveDeviceRamTierAssessment` lands). Pick handlers use this at decision
 * time; the finish path re-checks with the authoritative async resolve.
 */
export function peekDeviceRamTierAssessment(): DeviceRamTierAssessment | null {
  if (cachedAssessment) return cachedAssessment;
  if (!isAndroid && !isIOS) {
    cachedAssessment = classifyDeviceRamTier(null);
    return cachedAssessment;
  }
  const syncMb = readSyncDeviceTotalRamMb();
  if (syncMb !== null) {
    cachedAssessment = classifyDeviceRamTier(
      marketedRamGbFromTotalRamMb(syncMb),
    );
    return cachedAssessment;
  }
  return null;
}

/**
 * Resolve (and cache) the device RAM-tier assessment. Never rejects: an
 * unreachable probe classifies as the explicit "unknown" tier.
 */
export async function resolveDeviceRamTierAssessment(): Promise<DeviceRamTierAssessment> {
  const peeked = peekDeviceRamTierAssessment();
  if (peeked) return peeked;
  if (!resolveInFlight) {
    resolveInFlight = (async () => {
      const snapshot = await getDeviceResourceSnapshot();
      const assessment = classifyDeviceRamTier(
        marketedRamGbFromTotalRamMb(snapshot?.totalRamMb ?? null),
      );
      cachedAssessment = assessment;
      return assessment;
    })().finally(() => {
      resolveInFlight = null;
    });
  }
  return resolveInFlight;
}

/**
 * The fail-loud backstop for the first-run finish: throws when this device
 * may not run the on-device agent at all, or may not run on-device models
 * while the draft asks for them. The thrown message is user-facing — the
 * finish boundary renders it as the onboarding error turn with the recovery
 * choice (retry / different runtime / Settings).
 */
export async function assertDeviceRamTierAllowsLocalRuntime(
  localInference: string,
): Promise<void> {
  const assessment = await resolveDeviceRamTierAssessment();
  const allowsSelectedRuntime =
    localInference === "cloud-inference"
      ? assessment.allowsHybridAgent
      : assessment.allowsLocalAgent;
  if (!allowsSelectedRuntime) {
    throw new Error(
      `This device can't run the on-device agent: ${assessment.reason}. Pick "Eliza Cloud (managed)" instead.`,
    );
  }
  if (localInference === "all-local" && !assessment.allowsLocalModels) {
    throw new Error(
      `This device can't run on-device models: ${assessment.reason}. Pick "Eliza Cloud inference" instead.`,
    );
  }
}

/**
 * Boot-time enforcement, run right after the persisted-mode build reconcile in
 * `useStartupCoordinator` and before startup resolves its target: a persisted
 * "local" (or hybrid) mode on a RAM-blocked device — carried across reinstalls
 * by Capacitor Preferences, or written by a pre-#14390 build — is cleared so
 * the boot lands in onboarding instead of polling an agent the native gate
 * (ElizaAgentService.shouldAutoStart) now refuses to start. Uses the
 * synchronous probe only: Android is the platform whose native service
 * auto-start wedged boot; the iOS transport gates itself.
 */
export function enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot(): boolean {
  if (!isAndroid && !isIOS) return false;
  const mode = readPersistedMobileRuntimeMode();
  if (mode !== "local" && mode !== "cloud-hybrid") return false;
  const assessment = peekDeviceRamTierAssessment();
  const allowed =
    mode === "cloud-hybrid"
      ? assessment?.allowsHybridAgent
      : assessment?.allowsLocalAgent;
  if (!assessment || allowed) return false;
  const cleared = clearPersistedLocalRuntimeCommitment();
  logger.warn(
    { mode, marketedRamGb: assessment.marketedRamGb, ...cleared },
    "[DeviceRamGate] persisted local runtime mode is below the RAM floor; reverting to onboarding",
  );
  return true;
}
