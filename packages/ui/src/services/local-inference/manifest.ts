/**
 * Types for the Eliza-1 model manifest: tiers, backends, and device caps used to
 * pick the right bundle for the detected hardware.
 */
import type { CpuFeatureProbe } from "@elizaos/shared";

export type Eliza1Tier = "2b" | "4b" | "9b" | "27b" | "27b-256k";

export type Eliza1Backend = "cpu" | "metal" | "cuda" | "vulkan" | "rocm";

export interface Eliza1DeviceCaps {
  availableBackends: ReadonlyArray<Eliza1Backend>;
  ramMb: number;
  cpuFeatures?: CpuFeatureProbe;
}

export interface Eliza1FileEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface Eliza1Files {
  text: Eliza1FileEntry[];
  voice: Eliza1FileEntry[];
  asr?: Eliza1FileEntry[];
  vision?: Eliza1FileEntry[];
  cache: Eliza1FileEntry[];
  embedding?: Eliza1FileEntry[];
  imagegen?: Eliza1FileEntry[];
  vad?: Eliza1FileEntry[];
  wakeword?: Eliza1FileEntry[];
  turn?: Eliza1FileEntry[];
  eotLoraAdapter?: Eliza1FileEntry[];
  emotion?: Eliza1FileEntry[];
}

export interface Eliza1Manifest {
  id: string;
  version: string;
  tier: Eliza1Tier;
  ramBudgetMb: {
    min: number;
    recommended?: number;
  };
  kernels: {
    verifiedBackends: Record<
      Eliza1Backend,
      { status: "pass" | "fail" | "skip" }
    >;
  };
  files: Eliza1Files;
}

export const SUPPORTED_BACKENDS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Backend>>
> = {
  "2b": ["cpu", "metal", "cuda", "vulkan"],
  "4b": ["cpu", "metal", "cuda", "vulkan"],
  "9b": ["cpu", "metal", "cuda", "vulkan"],
  "27b": ["metal", "cuda", "vulkan"],
  "27b-256k": ["metal", "cuda", "vulkan"],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function parseManifestOrThrow(input: unknown): Eliza1Manifest {
  if (!isObject(input)) {
    throw new Error("Invalid Eliza-1 manifest: expected object");
  }
  const manifest = input as Partial<Eliza1Manifest>;
  if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    throw new Error("Invalid Eliza-1 manifest: missing id or version");
  }
  if (!manifest.files?.text?.length || !manifest.ramBudgetMb) {
    throw new Error(
      "Invalid Eliza-1 manifest: missing required files or RAM budget",
    );
  }
  if (!manifest.kernels?.verifiedBackends || !manifest.tier) {
    throw new Error(
      "Invalid Eliza-1 manifest: missing kernel verification data",
    );
  }
  return manifest as Eliza1Manifest;
}
