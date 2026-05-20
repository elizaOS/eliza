import type { TeeClaims, TeeKind, TeeMeasurementName } from "./tee-evidence.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

export type TeeReleaseManifestLike = {
  tee?: {
    enabled?: boolean;
    providers?: string[];
    measurements?: Record<string, string>;
    requiredClaims?: Record<string, boolean>;
    minSecurityVersion?: number;
  };
};

export type TeeReleasePolicyOptions = {
  required?: boolean;
  expectedNonce?: string;
  maxAgeMs?: number;
  nowMs?: number;
};

export function teePolicyFromReleaseManifest(
  manifest: TeeReleaseManifestLike,
  options: TeeReleasePolicyOptions = {},
): TeeEvidencePolicy {
  const tee = manifest.tee;
  if (!tee?.enabled) {
    return { required: options.required ?? false };
  }
  return {
    required: options.required ?? true,
    allowedKinds: normalizeProviders(tee.providers),
    requiredMeasurements: normalizeMeasurements(tee.measurements),
    requiredClaims: normalizeClaims(tee.requiredClaims),
    ...(tee.minSecurityVersion === undefined
      ? {}
      : { minSecurityVersion: tee.minSecurityVersion }),
    ...(options.expectedNonce === undefined
      ? {}
      : { expectedNonce: options.expectedNonce }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  };
}

function normalizeProviders(providers: string[] | undefined): TeeKind[] {
  return (providers ?? [])
    .map((provider) => provider.trim())
    .filter((provider): provider is TeeKind => provider.length > 0);
}

function normalizeMeasurements(
  measurements: Record<string, string> | undefined,
): Partial<Record<TeeMeasurementName, string>> {
  const normalized: Partial<Record<TeeMeasurementName, string>> = {};
  for (const [name, digest] of Object.entries(measurements ?? {})) {
    if (typeof digest === "string" && digest.trim()) {
      normalized[name] = digest.trim();
    }
  }
  return normalized;
}

function normalizeClaims(
  claims: Record<string, boolean> | undefined,
): Partial<Record<keyof TeeClaims, boolean>> {
  const normalized: Partial<Record<keyof TeeClaims, boolean>> = {};
  for (const [name, value] of Object.entries(claims ?? {})) {
    if (
      [
        "debugDisabled",
        "productionLifecycle",
        "secureBoot",
        "memoryEncrypted",
        "ioProtected",
        "gpuProtected",
        "npuProtected",
      ].includes(name) &&
      typeof value === "boolean"
    ) {
      normalized[name as keyof TeeClaims] = value;
    }
  }
  return normalized;
}
