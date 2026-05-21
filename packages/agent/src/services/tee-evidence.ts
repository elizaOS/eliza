export type TeeKind =
  | "tdx"
  | "sev-snp"
  | "nitro"
  | "cove"
  | "keystone"
  | "optee"
  | "dstack"
  | "eliza-vault"
  | "none"
  | (string & {});

export type TeeMeasurementName =
  | "boot"
  | "os"
  | "agent"
  | "policy"
  | "device"
  | "container"
  | "compose"
  | "monitor"
  | "modelWeights"
  | "npuFirmware"
  | "gpuFirmware"
  | (string & {});

export type TeeMeasurements = Partial<Record<TeeMeasurementName, string>>;

export type TeeClaims = {
  debugDisabled?: boolean;
  productionLifecycle?: boolean;
  secureBoot?: boolean;
  memoryEncrypted?: boolean;
  ioProtected?: boolean;
  gpuProtected?: boolean;
  npuProtected?: boolean;
};

export type TeeFreshness = {
  nonce?: string;
  timestamp?: string;
  verifier?: string;
};

export type TeeEvidence = {
  kind: TeeKind;
  provider?: string;
  hardwareVendor?: string;
  platformVersion?: string;
  securityVersion?: number;
  measurements?: TeeMeasurements;
  freshness?: TeeFreshness;
  claims?: TeeClaims;
  quote?: string;
  certificatePem?: string;
  reportData?: string;
  raw?: unknown;
};

export type TeeEvidenceProvider = {
  id: string;
  collectEvidence: () => Promise<TeeEvidence>;
};

export function isTeeEvidence(value: unknown): value is TeeEvidence {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string" && value.kind.trim().length > 0;
}

export function normalizeTeeEvidence(value: unknown): TeeEvidence {
  if (!isRecord(value)) {
    throw new Error("TEE evidence must be an object.");
  }
  const kind = readRequiredString(value, "kind");
  return {
    kind,
    ...(readOptionalString(value, "provider") === undefined
      ? {}
      : { provider: readOptionalString(value, "provider") }),
    ...(readOptionalString(value, "hardwareVendor") === undefined
      ? {}
      : { hardwareVendor: readOptionalString(value, "hardwareVendor") }),
    ...(readOptionalString(value, "platformVersion") === undefined
      ? {}
      : { platformVersion: readOptionalString(value, "platformVersion") }),
    ...(readOptionalInteger(value, "securityVersion") === undefined
      ? {}
      : { securityVersion: readOptionalInteger(value, "securityVersion") }),
    ...(normalizeMeasurements(value.measurements) === undefined
      ? {}
      : { measurements: normalizeMeasurements(value.measurements) }),
    ...(normalizeFreshness(value.freshness) === undefined
      ? {}
      : { freshness: normalizeFreshness(value.freshness) }),
    ...(normalizeClaims(value.claims) === undefined
      ? {}
      : { claims: normalizeClaims(value.claims) }),
    ...(readOptionalString(value, "quote") === undefined
      ? {}
      : { quote: readOptionalString(value, "quote") }),
    ...(readOptionalString(value, "certificatePem") === undefined
      ? {}
      : { certificatePem: readOptionalString(value, "certificatePem") }),
    ...(readOptionalString(value, "reportData") === undefined
      ? {}
      : { reportData: readOptionalString(value, "reportData") }),
    raw: value,
  };
}

export function teeMeasurementDigestMatches(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  return normalizeDigest(actual) === normalizeDigest(expected);
}

export function normalizeDigest(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256:")
    ? trimmed.slice("sha256:".length)
    : trimmed;
}

function normalizeMeasurements(value: unknown): TeeMeasurements | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("TEE evidence measurements must be an object.");
  }
  const measurements: TeeMeasurements = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new Error(`TEE measurement "${key}" must be a string.`);
    }
    const next = raw.trim();
    if (next.length > 0) {
      measurements[key] = next;
    }
  }
  return Object.keys(measurements).length === 0 ? undefined : measurements;
}

function normalizeFreshness(value: unknown): TeeFreshness | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("TEE evidence freshness must be an object.");
  }
  const freshness: TeeFreshness = {};
  const nonce = readOptionalString(value, "nonce");
  const timestamp = readOptionalString(value, "timestamp");
  const verifier = readOptionalString(value, "verifier");
  if (nonce !== undefined) freshness.nonce = nonce;
  if (timestamp !== undefined) freshness.timestamp = timestamp;
  if (verifier !== undefined) freshness.verifier = verifier;
  return Object.keys(freshness).length === 0 ? undefined : freshness;
}

function normalizeClaims(value: unknown): TeeClaims | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("TEE evidence claims must be an object.");
  }
  const claims: TeeClaims = {};
  for (const key of [
    "debugDisabled",
    "productionLifecycle",
    "secureBoot",
    "memoryEncrypted",
    "ioProtected",
    "gpuProtected",
    "npuProtected",
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") {
      throw new Error(`TEE claim "${key}" must be boolean.`);
    }
    claims[key] = value[key];
  }
  return Object.keys(claims).length === 0 ? undefined : claims;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = readOptionalString(value, key);
  if (result === undefined) {
    throw new Error(`TEE evidence field "${key}" is required.`);
  }
  return result;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`TEE evidence field "${key}" must be a string.`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`TEE evidence field "${key}" must be an integer.`);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
