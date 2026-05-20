import type { TeeMeasurementName } from "./tee-evidence.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

export type TeeRevocationEntry = {
  value: string | number;
  reason?: string;
  revokedAt?: string;
  source?: string;
};

export type TeeRevocationManifest = {
  schemaVersion: 1;
  authority?: string;
  revokedMeasurements?: Partial<
    Record<TeeMeasurementName, Array<string | TeeRevocationEntry>>
  >;
  revokedSecurityVersions?: Array<number | TeeRevocationEntry>;
};

export type NormalizedTeeRevocations = Pick<
  TeeEvidencePolicy,
  "revokedMeasurements" | "revokedSecurityVersions"
>;

export function mergeTeeRevocationsIntoPolicy(
  policy: TeeEvidencePolicy,
  manifest: TeeRevocationManifest | undefined,
): TeeEvidencePolicy {
  if (!manifest) return policy;
  const revocations = normalizeTeeRevocationManifest(manifest);
  return {
    ...policy,
    revokedMeasurements: mergeRevokedMeasurements(
      policy.revokedMeasurements,
      revocations.revokedMeasurements,
    ),
    revokedSecurityVersions: mergeNumbers(
      policy.revokedSecurityVersions,
      revocations.revokedSecurityVersions,
    ),
  };
}

export function normalizeTeeRevocationManifest(
  manifest: TeeRevocationManifest,
): NormalizedTeeRevocations {
  const revokedMeasurements: Partial<Record<TeeMeasurementName, string[]>> = {};
  for (const [name, entries] of Object.entries(
    manifest.revokedMeasurements ?? {},
  )) {
    const values = entries
      ?.map((entry) => normalizeRevocationValue(entry))
      .filter((value): value is string => typeof value === "string");
    if (values !== undefined && values.length > 0) {
      revokedMeasurements[name] = dedupeStrings(values);
    }
  }

  const revokedSecurityVersions = dedupeNumbers(
    (manifest.revokedSecurityVersions ?? [])
      .map((entry) => normalizeRevocationValue(entry))
      .filter((value): value is number => typeof value === "number"),
  );

  return {
    revokedMeasurements,
    revokedSecurityVersions,
  };
}

function normalizeRevocationValue(
  entry: string | number | TeeRevocationEntry,
): string | number | undefined {
  if (typeof entry === "string") return entry.trim() || undefined;
  if (typeof entry === "number" && Number.isSafeInteger(entry)) return entry;
  if (entry && typeof entry === "object") {
    if (typeof entry.value === "string") return entry.value.trim() || undefined;
    if (typeof entry.value === "number" && Number.isSafeInteger(entry.value)) {
      return entry.value;
    }
  }
  return undefined;
}

function mergeRevokedMeasurements(
  left: TeeEvidencePolicy["revokedMeasurements"],
  right: TeeEvidencePolicy["revokedMeasurements"],
): TeeEvidencePolicy["revokedMeasurements"] {
  const merged: Partial<Record<TeeMeasurementName, string[]>> = {};
  for (const [name, values] of Object.entries(left ?? {})) {
    merged[name] = dedupeStrings(values ?? []);
  }
  for (const [name, values] of Object.entries(right ?? {})) {
    merged[name] = dedupeStrings([...(merged[name] ?? []), ...(values ?? [])]);
  }
  return merged;
}

function mergeNumbers(
  left: number[] | undefined,
  right: number[] | undefined,
): number[] {
  return dedupeNumbers([...(left ?? []), ...(right ?? [])]);
}

function dedupeStrings(values: string[]): string[] {
  return [
    ...new Set(
      values.filter((value) => value.trim()).map((value) => value.trim()),
    ),
  ];
}

function dedupeNumbers(values: number[]): number[] {
  return [
    ...new Set(
      values.filter((value) => Number.isSafeInteger(value) && value >= 0),
    ),
  ].sort((a, b) => a - b);
}
