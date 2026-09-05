/**
 * Singleton accessor for the KMS client used by cloud-shared crypto helpers.
 *
 * Resolves the backend through `createKmsClient()` from `@elizaos/core/security/kms`
 * (memory in tests, local in cloud production with `ELIZA_LOCAL_ROOT_KEY`,
 * steward when explicitly configured).
 *
 * On Cloudflare Workers, secrets live on `c.env`, not `process.env`. We pass
 * `getCloudAwareEnv()` so `ELIZA_KMS_BACKEND` + `ELIZA_LOCAL_ROOT_KEY` are
 * visible to the factory regardless of runtime.
 *
 * The singleton is captured on first call. Tests should call
 * `resetKmsClientForTests()` between cases to re-resolve the backend.
 */

import { ElizaError } from "@elizaos/core/edge";
import { createKmsClient, type KmsClient, resolveKmsBackend } from "@elizaos/core/security/kms";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";

let _kms: KmsClient | null = null;

export function setKmsClient(client: KmsClient): void {
  _kms = client;
}

/**
 * Whether the ephemeral `memory` KMS backend may run in this environment.
 *
 * `memory` derives a fresh root key on every process start, so every record it
 * encrypts (agent pre-upgrade snapshots, API keys, BYO secrets) is permanently
 * undecryptable after the next restart. The #15310 staging incident was exactly
 * this: the staging worker ran `ELIZA_KMS_BACKEND=memory`, and the previous
 * guard only refused it in *production* (`ENVIRONMENT === "production"`), so
 * staging quietly orphaned every DEK on every bounce.
 *
 * Policy:
 *  - A deployed-environment marker is authoritative: `ENVIRONMENT` of
 *    `production` or `staging` always forbids `memory`, even if the local
 *    process runs under NODE_ENV=test (that combination only occurs in unit
 *    tests simulating a deployed Worker — which want the refusal).
 *  - Otherwise `memory` is allowed only for throwaway worlds: NODE_ENV of
 *    `test`/`development`, or the explicit local dev stack
 *    (`ENVIRONMENT === "local"`, set by cloud-api-dev / sync-api-dev-vars).
 *  - Anything else — including a bare daemon/sidecar launch with neither
 *    variable set — is treated as a real deployment that forgot its config,
 *    which is precisely the misconfig class this guards against.
 *
 * Exported for tests. Keep in sync with `assertKmsBackendDurable` in
 * `packages/cloud/scripts/admin/daemons/provisioning-worker.ts`, which applies
 * the same policy at daemon preflight (before any job is claimed).
 */
export function isEphemeralKmsAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging") {
    return false;
  }
  if (env.NODE_ENV === "test" || env.NODE_ENV === "development") {
    return true;
  }
  return env.ENVIRONMENT === "local";
}

export function getKmsClient(): KmsClient {
  if (!_kms) {
    const env = getCloudAwareEnv();
    if (resolveKmsBackend({ env }) === "memory" && !isEphemeralKmsAllowed(env)) {
      throw new ElizaError(
        "Refusing to start with the ephemeral 'memory' KMS backend outside " +
          "test/development: it rotates its key on every restart and orphans " +
          "every record it encrypts (snapshots, API keys, BYO secrets). Set " +
          "ELIZA_KMS_BACKEND=local with a persistent ELIZA_LOCAL_ROOT_KEY (or " +
          "configure the steward backend).",
        {
          code: "KMS_MEMORY_BACKEND_FORBIDDEN",
          severity: "fatal",
          context: {
            backend: "memory",
            environment: env.ENVIRONMENT ?? null,
            nodeEnv: env.NODE_ENV ?? null,
          },
        },
      );
    }
    _kms = createKmsClient({ env });
  }
  return _kms;
}

/** Reset for tests only. */
export function resetKmsClientForTests(): void {
  _kms = null;
}
