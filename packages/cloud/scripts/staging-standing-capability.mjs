#!/usr/bin/env node
/**
 * Checks the protected staging credential's moderation role without reading
 * account data or mutating standing. Deployment beacons bracket the HEAD-only
 * capability request. Their revision identifies only those health responses;
 * the capability response's deployment remains explicitly unverified.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ORIGIN = "https://api-staging.eliza.app";
const SHA = /^[a-f0-9]{40}$/;
const ROLES = new Set(["super_admin", "moderator", "viewer"]);
const FAILURE_CODES = new Set([
  "invalid_source_authority",
  "missing_protected_credential",
  "transport_failure",
  "deployment_http_failure",
  "deployment_schema_failure",
  "deployment_mismatch",
  "capability_http_failure",
  "capability_schema_failure",
  "missing_output_path",
]);

export class StandingCapabilityError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "StandingCapabilityError";
    this.code = code;
  }
}

export function validateCapabilityConfig(config) {
  if (
    config.sourceRef !== "refs/heads/develop" ||
    !SHA.test(config.sourceSha) ||
    !SHA.test(config.expectedDeploySha)
  ) {
    throw new StandingCapabilityError("invalid_source_authority");
  }
  if (typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw new StandingCapabilityError("missing_protected_credential");
  }
}

async function request(fetchImpl, path, init) {
  try {
    return await fetchImpl(`${ORIGIN}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    // error-policy:J2 transport details may contain private headers or URLs.
    throw new StandingCapabilityError("transport_failure", { cause });
  }
}

async function verifyDeployment(config, fetchImpl) {
  const response = await request(fetchImpl, "/api/health", { method: "GET" });
  if (response.status !== 200) {
    throw new StandingCapabilityError("deployment_http_failure");
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    // error-policy:J3 malformed health data cannot establish deployment identity.
    throw new StandingCapabilityError("deployment_schema_failure", { cause });
  }
  if (
    body?.commit !== config.expectedDeploySha ||
    body?.environment !== "staging"
  ) {
    throw new StandingCapabilityError("deployment_mismatch");
  }
}

export async function inspectStandingCapability(
  config,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  validateCapabilityConfig(config);
  await verifyDeployment(config, fetchImpl);
  const response = await request(fetchImpl, "/api/v1/admin/moderation", {
    method: "HEAD",
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (response.status !== 200) {
    throw new StandingCapabilityError("capability_http_failure");
  }
  const flag = response.headers.get("x-is-admin");
  const role = response.headers.get("x-admin-role");
  if (
    (flag !== "true" && flag !== "false") ||
    (flag === "true" && !ROLES.has(role)) ||
    (flag === "false" && role !== null && role !== "")
  ) {
    throw new StandingCapabilityError("capability_schema_failure");
  }
  await verifyDeployment(config, fetchImpl);
  return {
    schemaVersion: 2,
    kind: "staging_standing_capability",
    environment: "staging",
    sourceSha: config.sourceSha,
    healthObservedDeploySha: config.expectedDeploySha,
    capabilityDeployment: {
      status: "unverified",
      reason: "response_revision_not_verified",
    },
    observedAt: new Date(now()).toISOString(),
    httpStatus: 200,
    isAdmin: flag === "true",
    role: flag === "true" ? role : null,
    // HEAD also reports false for rejected credentials. It cannot establish
    // authentication success or permission to mutate a particular account.
    provesAuthentication: false,
    provesModerationMutation: false,
  };
}

/** Only enumerated local errors may reach public workflow logs. */
export function capabilityFailureCode(error) {
  return error instanceof StandingCapabilityError &&
    FAILURE_CODES.has(error.code)
    ? error.code
    : "internal_failure";
}

async function main() {
  const { values } = parseArgs({
    options: {
      "expected-deploy-sha": { type: "string" },
      "source-sha": { type: "string" },
      "source-ref": { type: "string" },
      output: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.output) throw new StandingCapabilityError("missing_output_path");
  const evidence = await inspectStandingCapability({
    expectedDeploySha: values["expected-deploy-sha"],
    sourceSha: values["source-sha"],
    sourceRef: values["source-ref"],
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflow injects this standalone credential outside Turbo caching.
    apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
  });
  await mkdir(dirname(values.output), { recursive: true, mode: 0o700 });
  await writeFile(values.output, `${JSON.stringify(evidence)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Staging standing capability evidence saved; no account mutation performed.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // error-policy:J1 raw response, transport, and CLI input errors remain private.
    console.error(`[standing-capability] ${capabilityFailureCode(error)}`);
    process.exitCode = 1;
  });
}
