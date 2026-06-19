import { createPublicKey, type KeyObject, verify } from "node:crypto";
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
  /** Identity of the signing authority; selects the trusted public key. */
  authority?: string;
  /**
   * Detached Ed25519 signature (base64) over the canonical manifest body (all
   * fields except `signature`). Verified at the load boundary against a
   * configured trusted authority key — see {@link verifyTeeRevocationManifest}.
   */
  signature?: string;
  revokedMeasurements?: Partial<
    Record<TeeMeasurementName, Array<string | TeeRevocationEntry>>
  >;
  revokedSecurityVersions?: Array<number | TeeRevocationEntry>;
};

export type TeeRevocationVerificationOptions = {
  /**
   * Trusted authority public keys, keyed by authority id. PEM (SPKI) Ed25519
   * keys. The manifest's `authority` selects which key must verify its
   * signature. When this map is empty, an unsigned manifest with no `authority`
   * is permitted (local dev); any manifest that *claims* an authority or
   * carries a signature is rejected because there is no anchor to verify it.
   */
  trustedAuthorities: Record<string, string>;
};

export type TeeRevocationVerificationResult =
  | { verified: true; authority?: string }
  | {
      verified: false;
      reason:
        | "unsigned-manifest"
        | "missing-authority"
        | "untrusted-authority"
        | "invalid-signature"
        | "malformed-key";
      detail?: string;
    };

/**
 * Verify a revocation manifest's Ed25519 signature against a configured set of
 * trusted authority keys. Fail-closed by construction:
 *
 * - No trusted authorities configured + manifest carries no `authority`/
 *   `signature` ⇒ verified (local-dev unsigned path).
 * - No trusted authorities configured but the manifest claims to be signed ⇒
 *   rejected (cannot verify a signed manifest with no anchor).
 * - Trusted authorities configured ⇒ the manifest MUST carry a matching
 *   `authority` + a `signature` that verifies; otherwise rejected.
 */
export function verifyTeeRevocationManifest(
  manifest: TeeRevocationManifest,
  options: TeeRevocationVerificationOptions,
): TeeRevocationVerificationResult {
  const trusted = options.trustedAuthorities;
  const anchorsConfigured = Object.keys(trusted).length > 0;

  if (!anchorsConfigured) {
    if (manifest.authority !== undefined || manifest.signature !== undefined) {
      return {
        verified: false,
        reason: "untrusted-authority",
        detail:
          "Manifest declares an authority/signature but no trusted authority key is configured.",
      };
    }
    return { verified: true };
  }

  if (manifest.signature === undefined || manifest.signature.trim() === "") {
    return { verified: false, reason: "unsigned-manifest" };
  }
  if (manifest.authority === undefined || manifest.authority.trim() === "") {
    return { verified: false, reason: "missing-authority" };
  }
  const pem = trusted[manifest.authority];
  if (pem === undefined) {
    return {
      verified: false,
      reason: "untrusted-authority",
      detail: `No trusted key for authority "${manifest.authority}".`,
    };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(pem);
  } catch (error) {
    return {
      verified: false,
      reason: "malformed-key",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const body = Buffer.from(canonicalizeRevocationBody(manifest), "utf8");
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(manifest.signature, "base64");
  } catch {
    return { verified: false, reason: "invalid-signature" };
  }
  const ok = verify(null, body, publicKey, signatureBytes);
  return ok
    ? { verified: true, authority: manifest.authority }
    : { verified: false, reason: "invalid-signature" };
}

/**
 * Deterministic JSON of the manifest body excluding `signature`. Object keys
 * are sorted recursively so the signer and verifier serialize identical bytes.
 */
export function canonicalizeRevocationBody(
  manifest: TeeRevocationManifest,
): string {
  const { signature: _signature, ...body } = manifest;
  return stableStringify(body);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

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
