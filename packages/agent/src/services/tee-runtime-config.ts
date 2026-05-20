import { readFile } from "node:fs/promises";
import type { TeeEvidencePolicy } from "./tee-policy.ts";
import {
  type TeeReleaseManifestLike,
  teePolicyFromReleaseManifest,
} from "./tee-release-policy.ts";
import {
  mergeTeeRevocationsIntoPolicy,
  type TeeRevocationManifest,
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
      JSON.parse(inlineRevocations) as TeeRevocationManifest,
    );
  }

  const revocationPath = env.ELIZA_TEE_REVOCATIONS_PATH;
  if (revocationPath?.trim()) {
    return mergeTeeRevocationsIntoPolicy(
      policy,
      JSON.parse(
        await readText(revocationPath.trim()),
      ) as TeeRevocationManifest,
    );
  }

  return policy;
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
