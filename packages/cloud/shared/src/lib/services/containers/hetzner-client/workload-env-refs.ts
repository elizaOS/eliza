/**
 * Provision-time sealing of container environment secrets into Steward's
 * WORKLOAD-scoped secret contract (`/v1/workload-secrets/*`) — issue #17432,
 * superseding the nonfunctional #17301 integration.
 *
 * THE GAP THIS CLOSES: `createContainer`/`setEnv` inject caller-supplied
 * `environment_vars` into `docker create -e KEY=value` verbatim, so secret
 * values sit (1) in the stored `containers.environment_vars` jsonb, (2) in
 * the SSH command line, and (3) in `docker inspect` output on the node — all
 * plaintext. With sealing enabled, secret-bearing values are written to
 * Steward at provision time and the container env carries only
 * `vault://workload/<workloadId>/<KEY>` reference sentinels plus a
 * LEAST-PRIVILEGE workload capability the in-container boot resolver uses to
 * exchange for the values (see
 * `packages/agent/src/runtime/operations/workload-secrets.ts`).
 *
 * WHY NOT `/secrets`: Steward's human secret CRUD requires an owner/admin
 * session with recent MFA and intentionally rejects machine credentials —
 * #17301 died on exactly that 403. The workload contract is the machine path:
 * the tenant API key (held ONLY by this control-plane process, never placed in
 * a container) may register/rotate/revoke workloads and WRITE values but can
 * never read one back or list inventory; the container holds only a
 * per-workload P-256 keypair whose short-lived enrollment tokens resolve the
 * workload's own namespace and nothing else.
 *
 * CAPABILITY LIFECYCLE (all server-enforced, see Steward
 * `packages/api/src/routes/workload-secrets.ts`):
 *   - every seal generates a FRESH keypair and re-registers the workload —
 *     Steward revokes the previous key in the same transaction, so
 *     create/setEnv doubles as capability rotation;
 *   - container deletion calls DELETE /workloads/:id, which kills enrollment
 *     and soft-deletes the namespace (an outstanding ≤5m token resolves
 *     nothing afterwards).
 *
 * FLAG-GATED, DEFAULT OFF (`CONTAINERS_ENV_VAULT_REFS=true`): existing
 * deployments keep the legacy plaintext behavior byte-for-byte. Do not enable
 * until the container image carries the boot resolver — the flag's doc block
 * in `containers-env.ts` states the pairing requirement.
 *
 * ERROR POLICY: fail CLOSED. When the flag is on and any Steward call fails,
 * provisioning throws BEFORE the DB row or any SSH — a fallback to plaintext
 * injection would silently re-open the hole the flag claims to close.
 */

import { createHash, webcrypto } from "node:crypto";
import { getCloudAwareEnv } from "../../../runtime/cloud-bindings";
import { logger } from "../../../utils/logger";
import { isSensitiveAgentEnvKey } from "../../agent-env-crypto";
import { HetznerClientError } from "./types";

/**
 * `vault://` sentinel prefix. MUST stay identical to `VAULT_REF_PREFIX` in
 * `packages/agent/src/runtime/operations/vault-bridge.ts` (the canonical
 * definition — cloud-shared cannot import packages/agent, so the constant is
 * mirrored here with this pin instead).
 */
export const VAULT_REF_PREFIX = "vault://";

/** Namespace prefix inside the sentinel marking a workload-contract ref. */
export const WORKLOAD_REF_NAMESPACE = "workload/";

/**
 * Capability env vars the sealed container receives INSTEAD of a tenant-wide
 * credential. `STEWARD_WORKLOAD_KEY` is the pkcs8-base64 P-256 private key of
 * a capability that can (a) mint short-lived tokens for (b) resolving this
 * one workload's namespace — revocable server-side, rotated on every reseal.
 * These are exempt from the sealing loop (sealing them would orphan the boot
 * resolver) and are replaced wholesale on every seal.
 */
export const WORKLOAD_CAPABILITY_ENV_KEYS = [
  "STEWARD_API_URL",
  "STEWARD_WORKLOAD_ID",
  "STEWARD_WORKLOAD_KEY",
] as const;

const CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(WORKLOAD_CAPABILITY_ENV_KEYS);

/** Format a vault key into the `vault://<key>` sentinel (vault-bridge format). */
export function formatVaultRef(key: string): string {
  if (!key) throw new TypeError("formatVaultRef requires a non-empty key");
  return `${VAULT_REF_PREFIX}${key}`;
}

/** Type guard matching vault-bridge's `isVaultRef`. */
export function isVaultRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(VAULT_REF_PREFIX) &&
    value.length > VAULT_REF_PREFIX.length
  );
}

/** Extract the vault key from a sentinel; null when malformed. */
export function parseVaultRef(value: string): string | null {
  return isVaultRef(value) ? value.slice(VAULT_REF_PREFIX.length) : null;
}

/**
 * Deterministic per-project workload id: stable across container recreates so
 * `setEnv`/recreate ROTATES the same workload (capability + values) instead of
 * leaking an orphan per recreate. Hash-derived so arbitrary org ids / project
 * names always fit Steward's `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` id contract.
 */
export function deriveWorkloadId(organizationId: string, projectName: string): string {
  const digest = createHash("sha256")
    .update(`${organizationId}/${projectName}`)
    .digest("hex")
    .slice(0, 40);
  return `wl-${digest}`;
}

/** The sentinel key for one env var: `workload/<workloadId>/<ENV_KEY>` — the
 * SAME string as the Steward secret name, so ref → resolve is pure string
 * manipulation on both sides. */
export function buildWorkloadRefKey(workloadId: string, envKey: string): string {
  return `${WORKLOAD_REF_NAMESPACE}${workloadId}/${envKey}`;
}

/** Steward transport config for the workload-secrets writer. */
export interface WorkloadStewardConfig {
  baseUrl: string;
  tenantId?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Result of sealing an env map. */
export interface SealedWorkloadEnv {
  /**
   * Env map safe to persist + inject: `vault://workload/...` refs for
   * secrets, the capability triplet, passthrough for everything else.
   */
  env: Record<string, string>;
  /** Env keys whose values were moved into Steward this call. */
  sealedKeys: string[];
  /** The workload id registered/rotated for this container. */
  workloadId: string;
}

function stewardHeaders(config: WorkloadStewardConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.tenantId) headers["X-Steward-Tenant"] = config.tenantId;
  if (config.apiKey) headers["X-Steward-Key"] = config.apiKey;
  return headers;
}

function stewardBase(config: WorkloadStewardConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}

async function stewardCall(
  config: WorkloadStewardConfig,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  failureContext: string,
): Promise<Response> {
  const doFetch = config.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${stewardBase(config)}${path}`, {
      method,
      headers: stewardHeaders(config),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // Steward unreachable (outage): fail closed. Message carries the context
    // and transport class only — never a secret value.
    throw new HetznerClientError(
      "container_create_failed",
      `Steward workload API unreachable while ${failureContext}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new HetznerClientError(
      "container_create_failed",
      `Steward workload API rejected ${failureContext} (HTTP ${res.status})`,
    );
  }
  return res;
}

/** Resolve steward transport config from env; throws when unconfigured (fail closed). */
export function resolveWorkloadStewardConfigFromEnv(): WorkloadStewardConfig {
  const env = getCloudAwareEnv();
  const baseUrl = env.STEWARD_API_URL?.trim();
  if (!baseUrl) {
    throw new HetznerClientError(
      "container_create_failed",
      "CONTAINERS_ENV_VAULT_REFS is enabled but STEWARD_API_URL is not configured on the control plane",
    );
  }
  return {
    baseUrl,
    tenantId:
      env.STEWARD_TENANT_ID?.trim() || env.NEXT_PUBLIC_STEWARD_TENANT_ID?.trim() || undefined,
    apiKey: env.STEWARD_TENANT_API_KEY?.trim() || undefined,
  };
}

/** Generate the per-workload P-256 capability keypair. The PRIVATE key goes
 * into the container env (pkcs8 base64); only the PUBLIC key goes to Steward. */
async function generateWorkloadKeypair(): Promise<{
  publicKeySpkiBase64: string;
  privateKeyPkcs8Base64: string;
}> {
  const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKeySpkiBase64: spki.toString("base64"),
    privateKeyPkcs8Base64: pkcs8.toString("base64"),
  };
}

/**
 * Seal an env map through the workload contract:
 *
 *   1. register/rotate the workload capability (fresh keypair; Steward revokes
 *      the previous key in the same transaction);
 *   2. write each secret-bearing value (same `isSensitiveAgentEnvKey`
 *      heuristic the agent-sandbox at-rest crypto uses, #11332) via
 *      `PUT /workloads/:id/secrets/:KEY` — upsert on first write, Steward's
 *      native versioned rotation after;
 *   3. return an env map carrying refs + the capability triplet.
 *
 * Values that are ALREADY refs pass through untouched but their keys are
 * still counted as sealed intent (read-modify-write PATCH flows echo stored
 * refs back; the value they point at is re-written only when the caller sends
 * a real value). Non-sensitive config passes through unchanged.
 */
export async function sealContainerEnvToWorkload(
  params: {
    organizationId: string;
    projectName: string;
    environmentVars: Record<string, string>;
  },
  config: WorkloadStewardConfig,
): Promise<SealedWorkloadEnv> {
  const workloadId = deriveWorkloadId(params.organizationId, params.projectName);
  const keypair = await generateWorkloadKeypair();

  // Capability issuance FIRST: if Steward is down or denies, nothing else
  // happens (no partial seal, no row, no SSH).
  await stewardCall(
    config,
    "POST",
    "/v1/workload-secrets/workloads",
    {
      workloadId,
      publicKey: keypair.publicKeySpkiBase64,
      label: `eliza-cloud ${params.organizationId}/${params.projectName}`.slice(0, 255),
    },
    `registering workload "${workloadId}"`,
  );

  const env: Record<string, string> = {};
  const sealedKeys: string[] = [];

  for (const [key, value] of Object.entries(params.environmentVars)) {
    // The capability triplet is control-plane-owned and replaced below —
    // never sealed (STEWARD_WORKLOAD_KEY matches the secret heuristic but
    // sealing it would orphan the boot resolver).
    if (CAPABILITY_KEY_SET.has(key)) continue;
    if (!isSensitiveAgentEnvKey(key) || !value || isVaultRef(value)) {
      env[key] = value;
      continue;
    }
    await stewardCall(
      config,
      "PUT",
      `/v1/workload-secrets/workloads/${encodeURIComponent(workloadId)}/secrets/${encodeURIComponent(key)}`,
      { value },
      `writing env secret "${key}" for workload "${workloadId}"`,
    );
    env[key] = formatVaultRef(buildWorkloadRefKey(workloadId, key));
    sealedKeys.push(key);
  }

  // The capability the boot resolver exchanges for the values. NOT a secret
  // value and NOT tenant-wide: scope = this one workload's namespace,
  // revocable via DELETE /workloads/:id, dead after any reseal.
  env.STEWARD_API_URL = stewardBase(config);
  env.STEWARD_WORKLOAD_ID = workloadId;
  env.STEWARD_WORKLOAD_KEY = keypair.privateKeyPkcs8Base64;

  if (sealedKeys.length > 0) {
    // Keys only — never values — mirroring the vault audit-log policy.
    logger.info("[workload-env-refs] sealed container env secrets to Steward workload", {
      organizationId: params.organizationId,
      projectName: params.projectName,
      workloadId,
      sealedKeys,
    });
  }

  return { env, sealedKeys, workloadId };
}

/**
 * Revoke a container's workload capability + namespace on deletion.
 *
 * Uses the workload id recorded in the stored env (so revocation still runs
 * if the flag was flipped off between create and delete). error-policy: the
 * container teardown is the primary operation — a revocation failure is
 * logged LOUDLY for operator follow-up (a live capability outliving its
 * container) but does not block the deletion; the capability is also dead the
 * next time the same org/project provisions (deterministic id ⇒ rotation).
 */
export async function revokeWorkloadForDeletedContainer(
  storedEnv: Record<string, string> | null | undefined,
  configResolver: () => WorkloadStewardConfig = resolveWorkloadStewardConfigFromEnv,
): Promise<void> {
  const workloadId = storedEnv?.STEWARD_WORKLOAD_ID;
  if (!workloadId) return;
  try {
    const config = configResolver();
    await stewardCall(
      config,
      "DELETE",
      `/v1/workload-secrets/workloads/${encodeURIComponent(workloadId)}`,
      undefined,
      `revoking workload "${workloadId}"`,
    );
    logger.info("[workload-env-refs] revoked workload capability for deleted container", {
      workloadId,
    });
  } catch (err) {
    logger.error(
      "[workload-env-refs] FAILED to revoke workload capability for deleted container — the capability may outlive the container; revoke manually or reprovision the project",
      {
        workloadId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
