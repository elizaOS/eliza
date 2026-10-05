/**
 * At-rest encryption for `agent_sandboxes.environment_vars` (#11332).
 *
 * The column is plain jsonb, and it is the one place users can land BYO
 * provider keys today (PATCH /v1/eliza/agents/:id/environment, agent create,
 * coding-container create). Without this layer those secrets sit in plaintext
 * at rest. Values whose key looks secret-bearing are encrypted on WRITE with
 * the EXISTING org-scoped envelope crypto (`FieldEncryptionService`:
 * AES-256-GCM, per-org DEK wrapped by `SECRETS_MASTER_KEY`, unbound `enc:v1:`
 * encoded strings, readable by pre-v2 daemons — the same primitive that already
 * protects tenant DB DSNs) and decrypted only at the points the env is
 * materialized for the agent (container create, fleet upgrade, runtime
 * bootstrap), so the running agent still sees
 * the real values.
 *
 * Backward compatible by construction:
 * - Decrypt passes any non-`enc:` envelope value through untouched, so legacy
 *   plaintext rows keep working with no forced backfill. Legacy plaintext
 *   secrets are opportunistically re-encrypted the next time the row's env is
 *   written through the service.
 * - Without `SECRETS_MASTER_KEY`, only permissive local/dev writes retain
 *   legacy plaintext with a warning. Deployed environments and managed Cloud
 *   delegation secrets always fail closed. To activate, configure the
 *   SAME key on the cloud API Worker and the provisioning daemon — the same
 *   deployment requirement tenant-DB DSN encryption (`user-database.ts`)
 *   already imposes.
 *
 * Platform-managed control-plane tokens (`RESERVED_PLATFORM_ENV_KEYS` plus the
 * legacy `ELIZAOS_API_KEY` alias) are NEVER encrypted: the control plane reads
 * them synchronously outside the materialization path (bridge auth headers,
 * the dedicated-agent proxy, pairing routes), and they are minted and owned by
 * the platform — they are not user BYO secrets.
 *
 * Values are NOT bound to `agent_sandboxes|<id>|environment_vars:<KEY>` AAD
 * coordinates: several writers encrypt before the row id exists (agent create
 * and coding-container create insert with a DB-generated id), and stored
 * ciphertexts legitimately move between rows (tier upgrade copies the source
 * env onto a new target row, warm-claim and backup/restore reuse maps), while
 * every reader (provision, image swap, managed launch, backup capture) would
 * also need the owning row id. Binding therefore waits for a migration that
 * threads the sandbox id through all writers and readers and re-encrypts on
 * relocation; until then these are unbound `enc:v1:` envelopes, which means
 * `FIELD_ENCRYPTION_REQUIRE_AAD=true` rejects them.
 */

import { ElizaError } from "@elizaos/core";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { fieldEncryption, isFieldEncryptionRequired } from "./field-encryption";
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
 * back to, and `ELIZA_ALLOW_WS_QUERY_TOKEN`.
 *
 * `ELIZA_ALLOW_WS_QUERY_TOKEN` is NOT a secret: `prepareManagedElizaEnvironment`
 * stamps the literal `"1"` on every managed agent as a boolean feature flag
 * (managed-eliza-config.ts). It only lands here because the deliberately broad
 * `SENSITIVE_ENV_KEY_PATTERN` matches the substring `TOKEN` in its NAME. Left
 * encryptable it makes the flag the single at-rest ciphertext on every agent
 * row, so any environment whose Worker holds `SECRETS_MASTER_KEY` while its
 * provisioning daemon does not fails EVERY provision closed at env
 * materialization — with no user secret involved at all.
 */
const NEVER_ENCRYPT_ENV_KEYS: ReadonlySet<string> = new Set(
  [...RESERVED_PLATFORM_ENV_KEYS, "ELIZAOS_API_KEY", "ELIZA_ALLOW_WS_QUERY_TOKEN"].map((key) =>
    key.toUpperCase(),
  ),
);

/** Whether a caller-supplied env key should be encrypted at rest. */
export function isSensitiveAgentEnvKey(key: string): boolean {
  if (key.toUpperCase() === "ELIZA_CLOUD_DELEGATION_CLIENT_SECRET") return true;
  if (NEVER_ENCRYPT_ENV_KEYS.has(key.toUpperCase())) return false;
  return key.toUpperCase() === "ENCRYPTION_SALT" || SENSITIVE_ENV_KEY_PATTERN.test(key);
}

/**
 * Encrypt the secret-bearing values of an agent env map for storage in
 * `agent_sandboxes.environment_vars`. Non-sensitive config values and
 * platform tokens pass through unchanged; values that are already `enc:`
 * ciphertext (e.g. a read-modify-write PATCH echoing stored values back) are
 * never double-encrypted.
 *
 * Plaintext compatibility is limited to permissive local/dev configuration
 * without a delegation secret; any real encryption failure propagates so a secret is never
 * silently persisted in plaintext when encryption was expected to work.
 */
export async function encryptAgentEnvVarsForStorage(
  organizationId: string,
  environmentVars: Record<string, string>,
): Promise<Record<string, string>> {
  // The materializer decrypts envelopes under every key, including ordinary
  // config keys. Check ownership before the no-plaintext fast path can return
  // an attacker-supplied envelope unchanged.
  for (const value of Object.values(environmentVars)) {
    if (typeof value === "string" && fieldEncryption.isEncrypted(value)) {
      await fieldEncryption.assertEncryptedValueOrganization(organizationId, value);
    }
  }
  const pending = Object.entries(environmentVars).filter(
    ([key, value]) =>
      isSensitiveAgentEnvKey(key) &&
      typeof value === "string" &&
      value.length > 0 &&
      !fieldEncryption.isEncrypted(value),
  );
  if (pending.length === 0) return { ...environmentVars };

  // Match FieldEncryptionService's cloud-aware key source. Delegation secrets
  // always require encryption, including otherwise permissive local/dev hosts.
  const env = getCloudAwareEnv();
  if (!env.SECRETS_MASTER_KEY) {
    const keys = pending.map(([key]) => key);
    if (keys.some((key) => key.toUpperCase() === "ELIZA_CLOUD_DELEGATION_CLIENT_SECRET")) {
      throw new ElizaError("Managed Cloud delegation requires encrypted environment storage", {
        code: "AGENT_ENV_ENCRYPTION_REQUIRED",
        severity: "fatal",
        context: { organizationId, keys },
      });
    }
    if (isFieldEncryptionRequired(env)) {
      throw new ElizaError(
        "SECRETS_MASTER_KEY is required to store agent environment secrets in this environment",
        {
          code: "AGENT_ENV_ENCRYPTION_REQUIRED",
          severity: "fatal",
          context: { organizationId, keys },
        },
      );
    }
    logger.warn(
      "[agent-env-crypto] SECRETS_MASTER_KEY not configured — storing agent environment secrets as PLAINTEXT (legacy behavior). Configure the key on the cloud API and provisioning daemon to encrypt at rest.",
      { organizationId, keys },
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
 * Materialize a stored agent env map back to real values. `enc:` values are
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
