/**
 * Provision-time sealing of container environment secrets (vault:// refs).
 *
 * THE GAP THIS CLOSES: `createContainer`/`setEnv` inject caller-supplied
 * `environment_vars` into `docker create -e KEY=value` verbatim, so secret
 * values sit (1) in the stored `containers.environment_vars` jsonb, (2) in
 * the SSH command line, and (3) in `docker inspect` output on the node —
 * all plaintext. With sealing enabled, secret-bearing values are written to
 * the Steward secret vault at provision time and the container env carries
 * only `vault://<key>` reference sentinels. The sentinel format is OWNED by
 * `packages/agent/src/runtime/operations/vault-bridge.ts` — do NOT fork the
 * scheme.
 *
 * NOT YET END-TO-END: no in-container resolver for `vault://cloud/env/...`
 * refs exists in this repo today — the agent-side vault bridge resolves
 * against the LOCAL @elizaos/vault and explicitly fail-closes vault refs on
 * ELIZA_CLOUD_PROVISIONED containers. Flipping the flag before a
 * Steward-backed boot resolver ships would hand containers the literal
 * sentinel strings as credentials. The flag MUST stay off until that
 * resolver lands (sibling lane).
 *
 * FLAG-GATED, DEFAULT OFF: sealing only runs when
 * `CONTAINERS_ENV_VAULT_REFS=true` (containersEnv.envVaultRefsEnabled), so
 * existing deployments keep the legacy plaintext behavior byte-for-byte.
 * To migrate (once the in-container resolver exists): configure
 * `STEWARD_API_URL` + `STEWARD_TENANT_API_KEY` on the control-plane
 * sidecar, ensure the Steward secrets surface accepts the tenant machine
 * credential (the `/v1/kms/*` lane), flip the flag, then recreate
 * containers (env cannot be mutated on a live container anyway — setEnv
 * recreates and reseals).
 *
 * ERROR POLICY: fail CLOSED. When the flag is on and a vault write fails,
 * provisioning throws — a fallback to plaintext injection would silently
 * re-open the hole the flag claims to close.
 *
 * Key naming: steward secret name and the sentinel key are the SAME string,
 * `cloud/env/<organizationId>/<projectName>/<ENV_KEY>`, so a resolver only
 * needs `parseVaultRef(value)` to know exactly which steward secret to
 * fetch. Project-scoped (not container-id-scoped) so a container recreate /
 * setEnv reuses (rotates) the same secret rows instead of leaking orphans.
 */

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
 * Stable steward secret name for one container env var. Doubles as the
 * sentinel key (`vault://<this>`), so ref → secret lookup is a pure string
 * operation on both sides.
 */
export function buildContainerEnvVaultKey(
  organizationId: string,
  projectName: string,
  envKey: string,
): string {
  return `cloud/env/${organizationId}/${projectName}/${envKey}`;
}

/** Minimal transport so tests can drive sealing with an in-memory steward. */
export interface VaultRefsStewardConfig {
  baseUrl: string;
  tenantId?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Result of sealing an env map. */
export interface SealedContainerEnv {
  /** Env map safe to persist + inject: refs for secrets, passthrough otherwise. */
  env: Record<string, string>;
  /** Env keys whose values were moved into the vault this call. */
  sealedKeys: string[];
}

function stewardHeaders(config: VaultRefsStewardConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.tenantId) headers["X-Steward-Tenant"] = config.tenantId;
  if (config.apiKey) headers["X-Steward-Key"] = config.apiKey;
  return headers;
}

/**
 * Upsert one secret value into the Steward vault.
 *
 * POST /secrets first (the common create path); a 409 duplicate falls through
 * to the rotate path: GET /secrets to find the row id by name, then
 * PUT /secrets/:id (Steward's versioned rotate). Any other failure throws —
 * fail closed, never fall back to plaintext injection.
 */
async function upsertStewardSecret(
  config: VaultRefsStewardConfig,
  name: string,
  value: string,
): Promise<void> {
  const doFetch = config.fetchImpl ?? fetch;
  const headers = stewardHeaders(config);
  const base = config.baseUrl.replace(/\/+$/, "");

  const createRes = await doFetch(`${base}/secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, value }),
  });
  if (createRes.ok) return;
  if (createRes.status !== 409) {
    throw new HetznerClientError(
      "container_create_failed",
      `Steward vault write failed for env secret "${name}" (HTTP ${createRes.status})`,
    );
  }

  // 409 = the secret exists; rotate it to the new value.
  const listRes = await doFetch(`${base}/secrets`, { method: "GET", headers });
  if (!listRes.ok) {
    throw new HetznerClientError(
      "container_create_failed",
      `Steward vault list failed while rotating env secret "${name}" (HTTP ${listRes.status})`,
    );
  }
  const listBody = (await listRes.json().catch(() => null)) as {
    data?: Array<{ id?: string; name?: string }>;
  } | null;
  const existing = listBody?.data?.find((row) => row.name === name);
  if (!existing?.id) {
    throw new HetznerClientError(
      "container_create_failed",
      `Steward vault reported env secret "${name}" as duplicate but it was not found on list`,
    );
  }
  const rotateRes = await doFetch(`${base}/secrets/${encodeURIComponent(existing.id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value }),
  });
  if (!rotateRes.ok) {
    throw new HetznerClientError(
      "container_create_failed",
      `Steward vault rotate failed for env secret "${name}" (HTTP ${rotateRes.status})`,
    );
  }
}

/** Resolve steward transport config from env; throws when unconfigured (fail closed). */
export function resolveStewardConfigFromEnv(): VaultRefsStewardConfig {
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

/**
 * Seal an env map: secret-bearing values (same `isSensitiveAgentEnvKey`
 * heuristic the agent-sandbox at-rest crypto uses, #11332) move into the
 * Steward vault and are replaced by `vault://` refs; non-sensitive config
 * and values that are ALREADY refs pass through untouched (idempotent for
 * read-modify-write PATCH flows that echo stored refs back).
 */
export async function sealContainerEnvToVault(
  params: {
    organizationId: string;
    projectName: string;
    environmentVars: Record<string, string>;
  },
  config: VaultRefsStewardConfig,
): Promise<SealedContainerEnv> {
  const env: Record<string, string> = {};
  const sealedKeys: string[] = [];

  for (const [key, value] of Object.entries(params.environmentVars)) {
    if (!isSensitiveAgentEnvKey(key) || !value || isVaultRef(value)) {
      env[key] = value;
      continue;
    }
    const vaultKey = buildContainerEnvVaultKey(params.organizationId, params.projectName, key);
    await upsertStewardSecret(config, vaultKey, value);
    env[key] = formatVaultRef(vaultKey);
    sealedKeys.push(key);
  }

  if (sealedKeys.length > 0) {
    // Keys only — never values — mirroring the vault audit-log policy.
    logger.info("[env-vault-refs] sealed container env secrets to vault", {
      organizationId: params.organizationId,
      projectName: params.projectName,
      sealedKeys,
    });
  }

  return { env, sealedKeys };
}
