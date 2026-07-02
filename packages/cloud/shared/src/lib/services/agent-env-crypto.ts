/**
 * At-rest encryption for `agent_sandboxes.environment_vars` (#11332).
 *
 * The column is plain jsonb, and it is the one place users can land BYO
 * provider keys today (PATCH /v1/eliza/agents/:id/environment, agent create,
 * coding-container create). Without this layer those secrets sit in plaintext
 * at rest. Values whose key looks secret-bearing are encrypted on WRITE with
 * the EXISTING org-scoped envelope crypto (`FieldEncryptionService`:
 * AES-256-GCM, per-org DEK wrapped by `SECRETS_MASTER_KEY`, `enc:v1:` encoded
 * strings — the same primitive that already protects tenant DB DSNs) and
 * decrypted only at the points the env is materialized for the agent (container
 * create, fleet upgrade, runtime bootstrap), so the running agent still sees
 * the real values.
 *
 * Backward compatible by construction:
 * - Decrypt passes any non-`enc:v1:` value through untouched, so legacy
 *   plaintext rows keep working with no forced backfill. Legacy plaintext
 *   secrets are opportunistically re-encrypted the next time the row's env is
 *   written through the service.
 * - When `SECRETS_MASTER_KEY` is not configured, writes stay plaintext (exact
 *   legacy behavior) with a structured warning, so environments without the
 *   key (local dev, self-hosters) do not break. To activate, configure the
 *   SAME key on the cloud API Worker and the provisioning daemon — the same
 *   deployment requirement tenant-DB DSN encryption (`user-database.ts`)
 *   already imposes.
 *
 * Platform-managed control-plane tokens (`RESERVED_PLATFORM_ENV_KEYS` plus the
 * legacy `ELIZAOS_API_KEY` alias) are NEVER encrypted: the control plane reads
 * them synchronously outside the materialization path (bridge auth headers,
 * the dedicated-agent proxy, pairing routes), and they are minted and owned by
 * the platform — they are not user BYO secrets.
 */

import { logger } from "../utils/logger";
import { fieldEncryption } from "./field-encryption";
import { RESERVED_PLATFORM_ENV_KEYS } from "./reserved-env-keys";

/**
 * Key-name heuristic for secret-bearing env vars (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GITHUB_TOKEN, AGENT_SERVER_SHARED_SECRET, ...). Deliberately
 * broad: a false positive only costs an encrypt/decrypt round-trip through the
 * materialization path; a false negative leaves a secret in plaintext.
 */
const SENSITIVE_ENV_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;

/**
 * Platform tokens the control plane must read synchronously from the stored
 * row (bridge auth, proxies, pairing) — never encrypted. All of them are
 * blocked from the user PATCH surface by the reserved-key gate except
 * `ELIZAOS_API_KEY`, the legacy bridge-token alias `getAgentApiToken` falls
 * back to.
 */
const NEVER_ENCRYPT_ENV_KEYS: ReadonlySet<string> = new Set(
  [...RESERVED_PLATFORM_ENV_KEYS, "ELIZAOS_API_KEY"].map((key) => key.toUpperCase()),
);

/** Whether a caller-supplied env key should be encrypted at rest. */
export function isSensitiveAgentEnvKey(key: string): boolean {
  if (NEVER_ENCRYPT_ENV_KEYS.has(key.toUpperCase())) return false;
  return SENSITIVE_ENV_KEY_PATTERN.test(key);
}

/**
 * Encrypt the secret-bearing values of an agent env map for storage in
 * `agent_sandboxes.environment_vars`. Non-sensitive config values and
 * platform tokens pass through unchanged; values that are already `enc:v1:`
 * ciphertext (e.g. a read-modify-write PATCH echoing stored values back) are
 * never double-encrypted.
 *
 * Fail-open ONLY for the key-not-configured case (legacy plaintext behavior,
 * loudly logged); any real encryption failure propagates so a secret is never
 * silently persisted in plaintext when encryption was expected to work.
 */
export async function encryptAgentEnvVarsForStorage(
  organizationId: string,
  environmentVars: Record<string, string>,
): Promise<Record<string, string>> {
  const pending = Object.entries(environmentVars).filter(
    ([key, value]) =>
      isSensitiveAgentEnvKey(key) &&
      typeof value === "string" &&
      value.length > 0 &&
      !fieldEncryption.isEncrypted(value),
  );
  if (pending.length === 0) return { ...environmentVars };

  // Same source FieldEncryptionService reads (the Worker populates process.env
  // from bindings under nodejs_compat). No key -> legacy plaintext, warn loud.
  if (!process.env.SECRETS_MASTER_KEY) {
    logger.warn(
      "[agent-env-crypto] SECRETS_MASTER_KEY not configured — storing agent environment secrets as PLAINTEXT (legacy behavior). Configure the key on the cloud API and provisioning daemon to encrypt at rest.",
      { organizationId, keys: pending.map(([key]) => key) },
    );
    return { ...environmentVars };
  }

  const out: Record<string, string> = { ...environmentVars };
  for (const [key, value] of pending) {
    out[key] = await fieldEncryption.encrypt(organizationId, value);
  }
  return out;
}

/**
 * Materialize a stored agent env map back to real values. `enc:v1:` values are
 * decrypted; everything else (legacy plaintext rows, non-sensitive config)
 * passes through untouched. Decrypt failures fail CLOSED with the key name —
 * handing ciphertext to a container as if it were the secret would be a silent
 * misconfiguration.
 */
export async function decryptAgentEnvVars(
  environmentVars: Record<string, string> | null | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environmentVars ?? {})) {
    if (typeof value === "string" && fieldEncryption.isEncrypted(value)) {
      try {
        out[key] = await fieldEncryption.decrypt(value);
      } catch (error) {
        throw new Error(
          `Failed to decrypt agent environment variable ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
