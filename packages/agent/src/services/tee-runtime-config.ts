import { readFile } from "node:fs/promises";
import type { TeeEvidencePolicy } from "./tee-policy.ts";
import {
  type TeeReleaseManifestLike,
  teePolicyFromReleaseManifest,
} from "./tee-release-policy.ts";
import {
  mergeTeeRevocationsIntoPolicy,
  type TeeRevocationManifest,
  verifyTeeRevocationManifest,
} from "./tee-revocation.ts";

export type TeeRuntimeConfigEnv = Record<string, string | undefined>;

export type ResolveTeeRuntimePolicyOptions = {
  env?: TeeRuntimeConfigEnv;
  readText?: (path: string) => Promise<string>;
  nowMs?: number;
};

export async function resolveTeeRuntimePolicy(
  options: ResolveTeeRuntimePolicyOptions = {},
): Promise<TeeEvidencePolicy | undefined> {
  const env = options.env ?? process.env;
  const readText =
    options.readText ?? ((filePath) => readFile(filePath, "utf8"));
  const inlinePolicy = env.ELIZA_TEE_POLICY_JSON;
  if (inlinePolicy?.trim()) {
    return withRuntimeRevocations(
      normalizeRuntimePolicy(JSON.parse(inlinePolicy), env, options.nowMs),
      env,
      readText,
    );
  }

  const policyPath = env.ELIZA_TEE_POLICY_PATH;
  if (policyPath?.trim()) {
    return withRuntimeRevocations(
      normalizeRuntimePolicy(
        JSON.parse(await readText(policyPath.trim())),
        env,
        options.nowMs,
      ),
      env,
      readText,
    );
  }

  const inlineManifest = env.ELIZA_TEE_RELEASE_MANIFEST_JSON;
  if (inlineManifest?.trim()) {
    return withRuntimeRevocations(
      teePolicyFromReleaseManifest(
        JSON.parse(inlineManifest) as TeeReleaseManifestLike,
        runtimePolicyOptions(env, options.nowMs),
      ),
      env,
      readText,
    );
  }

  const manifestPath = env.ELIZA_TEE_RELEASE_MANIFEST_PATH;
  if (manifestPath?.trim()) {
    return withRuntimeRevocations(
      teePolicyFromReleaseManifest(
        JSON.parse(
          await readText(manifestPath.trim()),
        ) as TeeReleaseManifestLike,
        runtimePolicyOptions(env, options.nowMs),
      ),
      env,
      readText,
    );
  }

  if (env.ELIZA_TEE_REQUIRED === "true") {
    return withRuntimeRevocations(
      {
        required: true,
        ...runtimePolicyOptions(env, options.nowMs),
      },
      env,
      readText,
    );
  }
  return undefined;
}

function normalizeRuntimePolicy(
  value: unknown,
  env: TeeRuntimeConfigEnv,
  nowMs: number | undefined,
): TeeEvidencePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TEE policy must be a JSON object.");
  }
  return {
    ...(value as TeeEvidencePolicy),
    ...runtimePolicyOptions(env, nowMs),
  };
}

async function withRuntimeRevocations(
  policy: TeeEvidencePolicy,
  env: TeeRuntimeConfigEnv,
  readText: (path: string) => Promise<string>,
): Promise<TeeEvidencePolicy> {
  const inlineRevocations = env.ELIZA_TEE_REVOCATIONS_JSON;
  if (inlineRevocations?.trim()) {
    return mergeTeeRevocationsIntoPolicy(
      policy,
      verifiedRevocationManifest(
        JSON.parse(inlineRevocations) as TeeRevocationManifest,
        env,
      ),
    );
  }

  const revocationPath = env.ELIZA_TEE_REVOCATIONS_PATH;
  if (revocationPath?.trim()) {
    return mergeTeeRevocationsIntoPolicy(
      policy,
      verifiedRevocationManifest(
        JSON.parse(
          await readText(revocationPath.trim()),
        ) as TeeRevocationManifest,
        env,
      ),
    );
  }

  return policy;
}

/**
 * Verify the revocation manifest's signature before it is merged into the
 * policy (plan §3.4 / A5). Refuses to merge an unsigned/invalid/untrusted
 * manifest when a trusted authority key is configured via
 * `ELIZA_TEE_REVOCATION_PUBKEY` (+ optional `ELIZA_TEE_REVOCATION_AUTHORITY`).
 * A revocation list is security-relevant data: a tampered or forged one could
 * silently un-revoke a compromised measurement, so this is fail-closed.
 */
function verifiedRevocationManifest(
  manifest: TeeRevocationManifest,
  env: TeeRuntimeConfigEnv,
): TeeRevocationManifest {
  const result = verifyTeeRevocationManifest(manifest, {
    trustedAuthorities: resolveRevocationAuthorities(manifest, env),
  });
  if (!result.verified) {
    throw new Error(
      `TEE revocation manifest rejected: ${result.reason}${
        result.detail ? ` (${result.detail})` : ""
      }.`,
    );
  }
  return manifest;
}

function resolveRevocationAuthorities(
  manifest: TeeRevocationManifest,
  env: TeeRuntimeConfigEnv,
): Record<string, string> {
  const pem = decodePublicKeyPem(env.ELIZA_TEE_REVOCATION_PUBKEY);
  if (pem === undefined) return {};
  const authorityId =
    env.ELIZA_TEE_REVOCATION_AUTHORITY?.trim() || manifest.authority || "";
  return { [authorityId]: pem };
}

/**
 * Accept either a raw PEM (containing a BEGIN header) or a base64-encoded PEM
 * (convenient for a single-line env var). Returns undefined when unset.
 */
function decodePublicKeyPem(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(
      "ELIZA_TEE_REVOCATION_PUBKEY must be a PEM public key or its base64 encoding.",
    );
  }
  return decoded;
}

function runtimePolicyOptions(
  env: TeeRuntimeConfigEnv,
  nowMs: number | undefined,
): Pick<TeeEvidencePolicy, "expectedNonce" | "maxAgeMs" | "nowMs"> {
  const maxAgeMs = parseOptionalPositiveInteger(env.ELIZA_TEE_MAX_AGE_MS);
  return {
    ...(env.ELIZA_TEE_EXPECTED_NONCE === undefined
      ? {}
      : { expectedNonce: env.ELIZA_TEE_EXPECTED_NONCE }),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    ...(nowMs === undefined ? {} : { nowMs }),
  };
}

function parseOptionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ELIZA_TEE_MAX_AGE_MS must be a positive integer.");
  }
  return parsed;
}
