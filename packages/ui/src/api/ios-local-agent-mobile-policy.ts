/**
 * Pure mobile hardware and model-load policy for the in-renderer local agent.
 * Native probes supply facts; this module turns them into bounded runtime
 * choices that can be tested without starting the iOS kernel.
 */

import { findCatalogModel } from "../services/local-inference/catalog";
import type {
  CatalogModel,
  HardwareProbe,
  InstalledModel,
} from "../services/local-inference/types";

export interface MobileModelLoadOptions {
  modelPath: string;
  contextSize: number;
  useGpu: boolean;
  maxThreads: number;
  draftContextSize: number;
  draftMin: number;
  draftMax: number;
  speculativeSamples: number;
  mobileSpeculative: boolean;
  cacheTypeK?: string;
  cacheTypeV?: string;
  disableThinking: boolean;
}

export function mobileRecommendedBucket(
  totalRamGb: number,
): HardwareProbe["recommendedBucket"] {
  if (totalRamGb >= 32) return "xl";
  if (totalRamGb >= 16) return "large";
  if (totalRamGb >= 12) return "mid";
  return "small";
}

export function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function fallbackMobileTotalRamGb(platform: "ios" | "android"): number {
  const browserMemory =
    typeof navigator === "undefined"
      ? null
      : positiveFiniteNumber(
          (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        );
  if (browserMemory) return browserMemory;
  return platform === "ios" ? 8 : 4;
}

export function normalizeMobilePlatform(
  platform: "ios" | "android" | "web" | undefined,
): "ios" | "android" {
  return platform === "android" ? "android" : "ios";
}

export function gpuBackendForMobile(
  platform: "ios" | "android",
  backend?: "metal" | "vulkan" | "gpu-delegate",
): "metal" | "vulkan" {
  if (backend === "vulkan") return "vulkan";
  return platform === "android" ? "vulkan" : "metal";
}

export function buildMobileLoadOptions(
  model: InstalledModel,
  hardware: HardwareProbe,
): MobileModelLoadOptions {
  const catalog: CatalogModel | undefined = findCatalogModel(model.id);
  const targetContext = catalog?.contextLength ?? 4096;
  const contextSize =
    hardware.totalRamGb >= 12
      ? Math.min(targetContext, 8192)
      : hardware.totalRamGb >= 8
        ? Math.min(targetContext, 6144)
        : Math.min(targetContext, 4096);
  const maxThreads =
    Number.isFinite(hardware.cpuCores) && hardware.cpuCores > 0
      ? Math.max(2, Math.min(Math.floor(hardware.cpuCores) - 1, 6))
      : 0;
  const mtp = catalog?.runtime?.mtp;
  return {
    modelPath: model.path,
    contextSize,
    useGpu: hardware.mobile?.gpuSupported !== false,
    maxThreads,
    draftContextSize: contextSize,
    draftMin: mtp?.draftMin ?? 1,
    draftMax: mtp?.draftMax ?? 1,
    speculativeSamples: Math.min(mtp?.draftMax ?? 1, 4),
    mobileSpeculative: true,
    cacheTypeK: catalog?.runtime?.kvCache?.typeK,
    cacheTypeV: catalog?.runtime?.kvCache?.typeV,
    disableThinking: true,
  };
}
