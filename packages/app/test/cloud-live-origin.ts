/**
 * API-origin contract for the opt-in real Cloud Playwright lane (#18076).
 *
 * The live stack proxies /api/cloud/* to whatever `resolveCloudApiBaseUrl`
 * yields from the inherited environment, so a lane that intends to exercise
 * staging can silently drive production if `ELIZAOS_CLOUD_BASE_URL` is
 * missing. This module resolves the exact origin the spawned runtime will
 * target and, when the workflow pins `ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV`,
 * refuses a mismatched or defaulted origin instead of falling back. Consumed
 * by cloud-live.spec.ts before any auth/provision/chat step runs.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  type ElizaCloudEnvironment,
  resolveCloudApiBaseUrl,
} from "@elizaos/shared/elizacloud";

export type CloudLiveOriginContract = {
  /** Resolved `<origin>/api/v1` base the runtime's Cloud proxy will call. */
  apiBase: string;
  /** Origin component of {@link apiBase}. */
  origin: string;
  /** Canonical environment of the resolved origin, or "custom". */
  environment: ElizaCloudEnvironment | "custom";
  /** Environment the lane declared it must target, if any. */
  expected: ElizaCloudEnvironment | null;
  /** True when the resolution satisfies the declared expectation. */
  ok: boolean;
  /** Populated when `ok` is false: why the lane must not proceed. */
  reason?: string;
};

function classifyOrigin(origin: string): ElizaCloudEnvironment | "custom" {
  for (const environment of ["production", "staging"] as const) {
    if (
      origin ===
      new URL(ELIZA_DOMAIN_CONTRACTS[environment].cloudApiOrigin).origin
    ) {
      return environment;
    }
  }
  return "custom";
}

export function resolveCloudLiveOriginContract(
  env: NodeJS.ProcessEnv = process.env,
): CloudLiveOriginContract {
  const expectedRaw =
    env.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV?.trim().toLowerCase();
  const expected: ElizaCloudEnvironment | null =
    expectedRaw === "staging" || expectedRaw === "production"
      ? expectedRaw
      : null;

  // resolveCloudApiBaseUrl consults the ELIZAOS_CLOUD_BASE_URL env override
  // internally; passing the same value keeps injected-env unit coverage and
  // the real process resolution identical.
  const apiBase = resolveCloudApiBaseUrl(env.ELIZAOS_CLOUD_BASE_URL);

  let origin: string;
  try {
    origin = new URL(apiBase).origin;
  } catch {
    // error-policy:J3 a malformed resolved base is reported as an explicit
    // failed contract, never as a healthy-looking default origin.
    return {
      apiBase,
      origin: "",
      environment: "custom",
      expected,
      ok: false,
      reason: `resolved Cloud API base is not a valid URL: ${apiBase}`,
    };
  }

  const environment = classifyOrigin(origin);

  if (expectedRaw && !expected) {
    return {
      apiBase,
      origin,
      environment,
      expected: null,
      ok: false,
      reason: `ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV must be "staging" or "production", got "${expectedRaw}"`,
    };
  }

  if (!expected) {
    return { apiBase, origin, environment, expected, ok: true };
  }

  if (expected === "staging" && !env.ELIZAOS_CLOUD_BASE_URL?.trim()) {
    return {
      apiBase,
      origin,
      environment,
      expected,
      ok: false,
      reason:
        "staging lane requires an explicit ELIZAOS_CLOUD_BASE_URL; refusing the production default",
    };
  }

  if (environment !== expected) {
    return {
      apiBase,
      origin,
      environment,
      expected,
      ok: false,
      reason: `lane expected the ${expected} Cloud API but resolved ${origin} (${environment})`,
    };
  }

  return { apiBase, origin, environment, expected, ok: true };
}
