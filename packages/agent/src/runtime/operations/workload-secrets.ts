/**
 * In-container boot resolver for Steward WORKLOAD-scoped secret refs
 * (issue #17432).
 *
 * When a cloud container was provisioned with `CONTAINERS_ENV_VAULT_REFS`,
 * its environment carries `vault://workload/<workloadId>/<KEY>` sentinels
 * instead of secret values, plus a per-container capability:
 *
 *   STEWARD_API_URL       — the Steward endpoint
 *   STEWARD_WORKLOAD_ID   — this container's workload identity
 *   STEWARD_WORKLOAD_KEY  — pkcs8-base64 P-256 private key (LEAST PRIVILEGE:
 *                           it can only mint short-lived tokens that resolve
 *                           THIS workload's namespace; it is revoked
 *                           server-side on container delete and rotated on
 *                           every reseal — it is NOT a tenant credential)
 *
 * This module exchanges that capability for the values at boot:
 *   1. `POST /agent-enroll/challenge` → sign the canonical string with the
 *      workload key (ECDSA P-256 / SHA-256, base64 P1363 — the exact format
 *      Steward's `verifyP256Signature` verifies);
 *   2. `POST /agent-enroll/verify` → short-lived agent token;
 *   3. `POST /v1/workload-secrets/resolve` with the ref-named keys.
 *
 * DELIVERY CONTRACT (the issue's core requirement): resolved plaintext goes
 * ONLY into the runtime-settings overlay consumed by
 * `buildRuntimeSettings({ connectorSecretsOverlay })` — never `process.env`.
 * Combined with the projection's unresolved-sentinel filter, a plugin can
 * receive the real value via `runtime.getSetting()` while `process.env`,
 * `docker inspect`, and the container env never contain it, and a plugin can
 * never receive the ref literal as a credential.
 *
 * ERROR POLICY: fail closed, keys-only logging. Any failure (missing
 * capability, enrollment denial, revocation, Steward outage, partial
 * response) resolves NOTHING for the affected keys and reports key names
 * only — never values, never raw upstream errors that could embed them.
 */

import { webcrypto } from "node:crypto";
import { logger } from "@elizaos/core";
import { isVaultRef, parseVaultRef } from "./vault-bridge.ts";

/** Namespace prefix marking a workload-contract ref (vs. local-vault refs). */
export const WORKLOAD_REF_NAMESPACE = "workload/";

/** Env keys carrying the workload capability. Mirrored (with a pin) in
 * `packages/cloud/shared/.../workload-env-refs.ts` — the writer side. */
export interface WorkloadCapabilityEnv {
  apiUrl: string;
  workloadId: string;
  privateKeyPkcs8Base64: string;
}

/** True when `value` is a `vault://workload/...` sentinel. */
export function isWorkloadRef(value: unknown): value is string {
  if (!isVaultRef(value)) return false;
  const key = parseVaultRef(value);
  return key !== null && key.startsWith(WORKLOAD_REF_NAMESPACE);
}

/**
 * Extract the secret NAME from a workload ref addressed to `workloadId`.
 * Returns null for malformed refs or refs addressed to a DIFFERENT workload
 * (those are unresolvable by construction — this capability cannot read
 * another namespace — so they fail closed as missing).
 */
export function parseWorkloadRefName(
  value: string,
  workloadId: string,
): string | null {
  const key = parseVaultRef(value);
  if (key === null) return null;
  const prefix = `${WORKLOAD_REF_NAMESPACE}${workloadId}/`;
  if (!key.startsWith(prefix)) return null;
  const name = key.slice(prefix.length);
  return name.length > 0 ? name : null;
}

/** Read the workload capability from env; null when absent (not an error —
 * absence simply means this container was not provisioned with sealing). */
export function readWorkloadCapability(
  env: NodeJS.ProcessEnv = process.env,
): WorkloadCapabilityEnv | null {
  const apiUrl = env.STEWARD_API_URL?.trim();
  const workloadId = env.STEWARD_WORKLOAD_ID?.trim();
  const privateKeyPkcs8Base64 = env.STEWARD_WORKLOAD_KEY?.trim();
  if (!apiUrl || !workloadId || !privateKeyPkcs8Base64) return null;
  return { apiUrl, workloadId, privateKeyPkcs8Base64 };
}

/** Fetch signature so tests can inject transports; default is global fetch. */
export type FetchLike = typeof fetch;

interface EnrollmentResult {
  token: string;
}

/** Sign `canonicalString` with the capability key — ECDSA P-256/SHA-256,
 * base64 P1363 signature (the exact format Steward's verifier expects). */
async function signCanonicalString(
  privateKeyPkcs8Base64: string,
  canonicalString: string,
): Promise<string> {
  const pkcs8 = Buffer.from(privateKeyPkcs8Base64, "base64");
  const key = await webcrypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false, // non-extractable import — the key material never re-exports
    ["sign"],
  );
  const data = new TextEncoder().encode(canonicalString);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data),
  );
  return Buffer.from(signature).toString("base64");
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body (proxy error page, truncated response). Deliberate
    // fail-closed: `json` stays null and every downstream field read treats
    // the response as malformed — nothing is fabricated from it.
    json = null;
  }
  return { status: res.status, json };
}

/** Enroll: challenge → sign → verify → short-lived agent token. Throws a
 * keys-free Error on any denial/malformation. */
async function enrollWorkload(
  capability: WorkloadCapabilityEnv,
  fetchImpl: FetchLike,
): Promise<EnrollmentResult> {
  const base = capability.apiUrl.replace(/\/+$/, "");

  const challenge = await postJson(
    fetchImpl,
    `${base}/agent-enroll/challenge`,
    {
      agentId: capability.workloadId,
    },
  );
  const challengeData =
    challenge.status === 200 &&
    challenge.json?.ok === true &&
    typeof challenge.json.data === "object" &&
    challenge.json.data !== null
      ? (challenge.json.data as Record<string, unknown>)
      : null;
  const nonce =
    typeof challengeData?.nonce === "string" ? challengeData.nonce : null;
  const canonicalString =
    typeof challengeData?.canonicalString === "string"
      ? challengeData.canonicalString
      : null;
  if (!nonce || !canonicalString) {
    throw new Error(
      `workload enrollment challenge failed (HTTP ${challenge.status})`,
    );
  }

  const signature = await signCanonicalString(
    capability.privateKeyPkcs8Base64,
    canonicalString,
  );
  const verify = await postJson(fetchImpl, `${base}/agent-enroll/verify`, {
    agentId: capability.workloadId,
    nonce,
    signature,
  });
  const verifyData =
    verify.status === 200 &&
    verify.json?.ok === true &&
    typeof verify.json.data === "object" &&
    verify.json.data !== null
      ? (verify.json.data as Record<string, unknown>)
      : null;
  const token = typeof verifyData?.token === "string" ? verifyData.token : null;
  if (!token) {
    throw new Error(`workload enrollment denied (HTTP ${verify.status})`);
  }
  return { token };
}

/** Outcome of a boot resolution pass. `failures` carries KEY NAMES ONLY. */
export interface WorkloadResolutionResult {
  /** env-key → plaintext, for the runtime-settings overlay ONLY. */
  resolved: Record<string, string>;
  /** env keys that could not be resolved (fail-closed), names only. */
  failures: string[];
}

/**
 * Resolve every `vault://workload/...` sentinel in `envVars` into a
 * settings-only overlay via the container's workload capability.
 *
 * Self-gating: returns immediately with zero network calls when no workload
 * refs are present. Fail-closed: when the capability is absent/denied/
 * unreachable, every ref key is reported in `failures` (names only) and
 * nothing is resolved — the projection layer already strips unresolved
 * sentinels, so a plugin never sees the ref literal either.
 */
export async function resolveWorkloadSecretSettings(
  envVars: Record<string, string>,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {},
): Promise<WorkloadResolutionResult> {
  const refEntries = Object.entries(envVars).filter(([, value]) =>
    isWorkloadRef(value),
  );
  if (refEntries.length === 0) return { resolved: {}, failures: [] };

  const refKeys = refEntries.map(([key]) => key);
  const capability = readWorkloadCapability(options.env ?? process.env);
  if (!capability) {
    logger.error(
      `[workload-secrets] workload ref(s) present but no STEWARD_WORKLOAD_ID/KEY capability in the environment (fail-closed): ${refKeys.join(", ")}`,
    );
    return { resolved: {}, failures: refKeys };
  }

  // Map env key → workload secret NAME; refs addressed to a different
  // workload are unresolvable by construction and fail closed immediately.
  const nameByEnvKey = new Map<string, string>();
  const failures: string[] = [];
  for (const [envKey, value] of refEntries) {
    const name = parseWorkloadRefName(value, capability.workloadId);
    if (name === null) {
      failures.push(envKey);
    } else {
      nameByEnvKey.set(envKey, name);
    }
  }
  if (nameByEnvKey.size === 0) {
    if (failures.length > 0) {
      logger.error(
        `[workload-secrets] workload ref(s) not addressed to this workload (fail-closed): ${failures.join(", ")}`,
      );
    }
    return { resolved: {}, failures };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let token: string;
  try {
    ({ token } = await enrollWorkload(capability, fetchImpl));
  } catch (err) {
    // Enrollment failure (revoked capability, Steward outage, malformed
    // response) fails ALL pending keys closed. The thrown message is
    // keys-free by construction (status codes only); log key names here.
    logger.error(
      `[workload-secrets] workload enrollment failed (fail-closed): ${
        err instanceof Error ? err.message : String(err)
      } — unresolved: ${[...nameByEnvKey.keys()].join(", ")}`,
    );
    return { resolved: {}, failures: [...failures, ...nameByEnvKey.keys()] };
  }

  const base = capability.apiUrl.replace(/\/+$/, "");
  let resolveRes: Awaited<ReturnType<typeof postJson>>;
  try {
    resolveRes = await postJson(
      fetchImpl,
      `${base}/v1/workload-secrets/resolve`,
      { names: [...new Set(nameByEnvKey.values())] },
      { authorization: `Bearer ${token}` },
    );
  } catch (err) {
    logger.error(
      `[workload-secrets] workload resolve call failed (fail-closed): ${
        err instanceof Error ? err.message : String(err)
      } — unresolved: ${[...nameByEnvKey.keys()].join(", ")}`,
    );
    return { resolved: {}, failures: [...failures, ...nameByEnvKey.keys()] };
  }

  const data =
    resolveRes.status === 200 &&
    resolveRes.json?.ok === true &&
    typeof resolveRes.json.data === "object" &&
    resolveRes.json.data !== null
      ? (resolveRes.json.data as Record<string, unknown>)
      : null;
  const secrets =
    data && typeof data.secrets === "object" && data.secrets !== null
      ? (data.secrets as Record<string, unknown>)
      : null;
  if (!secrets) {
    logger.error(
      `[workload-secrets] workload resolve rejected (HTTP ${resolveRes.status}, fail-closed) — unresolved: ${[...nameByEnvKey.keys()].join(", ")}`,
    );
    return { resolved: {}, failures: [...failures, ...nameByEnvKey.keys()] };
  }

  const resolved: Record<string, string> = {};
  for (const [envKey, name] of nameByEnvKey) {
    const value = secrets[name];
    if (typeof value === "string" && value.length > 0) {
      resolved[envKey] = value;
    } else {
      // Missing from the namespace (revoked / never written): fail closed.
      failures.push(envKey);
    }
  }
  if (failures.length > 0) {
    logger.error(
      `[workload-secrets] workload ref(s) missing from the namespace (fail-closed): ${failures.join(", ")}`,
    );
  }
  return { resolved, failures };
}

/**
 * Boot-path entry: resolve every workload ref present in `process.env` into a
 * settings-only overlay, then SCRUB the environment:
 *
 *   - every ref-valued key is DELETED from `process.env` (the issue contract:
 *     neither plaintext NOR unresolved sentinels may sit in `process.env`
 *     where an env-reading plugin could pick a sentinel up as a credential);
 *   - `STEWARD_WORKLOAD_KEY` is DELETED after the exchange so the capability
 *     private key is not readable via `process.env` for the rest of the
 *     process lifetime (it remains rotated-per-reseal and revocable
 *     server-side regardless).
 *
 * Self-gating: zero work, zero scrubbing, zero network when no workload refs
 * are present (every non-sealed environment). Called from `startEliza` on the
 * real cloud container boot path.
 */
let bootOverlayCache: Record<string, string> | null = null;

/** @internal test hook — clears the boot overlay single-flight cache. */
export function __resetWorkloadBootOverlayCacheForTest(): void {
  bootOverlayCache = null;
}

export async function resolveWorkloadEnvOverlayForBoot(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<Record<string, string>> {
  // Single-flight: the capability key is scrubbed from process.env after the
  // first pass, so hot-reload (which rebuilds runtime settings) must reuse
  // the cold-boot resolution instead of failing on the now-absent key.
  if (bootOverlayCache !== null && !options.env) return bootOverlayCache;
  const env = options.env ?? process.env;

  const refEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isWorkloadRef(value)) refEnv[key] = value;
  }
  if (Object.keys(refEnv).length === 0) return {};

  const { resolved } = await resolveWorkloadSecretSettings(refEnv, {
    env,
    fetchImpl: options.fetchImpl,
  });

  // Scrub AFTER resolution: sentinels out of process.env (resolved or not —
  // failures are already logged keys-only and fail closed), capability key out
  // once it has served its purpose.
  for (const key of Object.keys(refEnv)) {
    delete env[key];
  }
  delete env.STEWARD_WORKLOAD_KEY;

  if (!options.env) bootOverlayCache = resolved;
  return resolved;
}
