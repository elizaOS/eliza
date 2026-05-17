/**
 * Hardware probe for local inference sizing.
 *
 * Uses `node-llama-cpp` when available to read GPU backend + VRAM. Falls back
 * to Node's `os` module when the binding isn't installed — we don't require
 * the plugin to be loaded for the probe endpoint to return useful data.
 *
 * Dynamic import is intentional: the binding pulls a native prebuilt that we
 * don't want eagerly required at module-load time (breaks CI environments
 * without the trusted-dependency flag).
 */
import type { HardwareProbe, OpenVinoHardwareProbe } from "./types";

interface OpenVinoDetectionHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
}
export declare function detectOpenVinoDevices(
  host?: OpenVinoDetectionHost,
): OpenVinoHardwareProbe;
/**
 * Read current system + GPU state. Cheap enough to call per-request; no
 * internal caching so the UI always reflects live VRAM usage.
 */
export declare function probeHardware(): Promise<HardwareProbe>;
/**
 * Compatibility assessment for a specific model given current hardware.
 *
 * Green/fits: comfortable headroom (model < 70% of effective memory).
 * Yellow/tight: will run but may swap or stutter under load.
 * Red/wontfit: exceeds available memory.
 */
export declare function assessFit(
  probe: HardwareProbe,
  modelSizeGb: number,
  minRamGb: number,
): "fits" | "tight" | "wontfit";
export type OnboardingMemoryFit = "fits" | "tight" | "wontfit";
export type OnboardingDiskFit = "fits" | "low-disk" | "critical-disk";
export type OnboardingRecommendation =
  | "local-ok"
  | "local-with-warning"
  | "cloud-only";
export interface OnboardingHardwareAdvice {
  memory: OnboardingMemoryFit;
  disk: OnboardingDiskFit;
  recommended: OnboardingRecommendation;
  reasons: string[];
}
export interface OnboardingHardwareModel {
  sizeBytes: number;
  ramGbRequired: number;
}
export interface OnboardingHardwareOptions {
  workspacePath?: string;
}
export declare function assessOnboardingHardware(
  model: OnboardingHardwareModel,
  opts?: OnboardingHardwareOptions,
): Promise<OnboardingHardwareAdvice>;
//# sourceMappingURL=hardware.d.ts.map
