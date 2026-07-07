/**
 * Singleton accessor for the KMS client used by cloud-shared crypto helpers.
 *
 * Resolves the backend through `createKmsClient()` from `@elizaos/security`
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

import { ElizaError } from "@elizaos/core";
import { createKmsClient, type KmsClient, resolveKmsBackend } from "@elizaos/security/kms";
import { isProductionDeployment } from "../../lib/config/deployment-environment";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";

let _kms: KmsClient | null = null;

export function setKmsClient(client: KmsClient): void {
  _kms = client;
}

export function getKmsClient(): KmsClient {
  if (!_kms) {
    const env = getCloudAwareEnv();
    // Fail-fast: the ephemeral `memory` backend derives a fresh per-process key
    // on every start, so everything it encrypts (agent pre-upgrade snapshots,
    // API keys, BYO secrets) is orphaned on the next restart — the prior key is
    // gone, and decrypt of an older record fails closed (KeyNotFoundError / AEAD
    // auth failure). It is a test-only backend; in a real cloud deployment it
    // silently bricks agent resume (a provisioning worker misconfigured with
    // ELIZA_KMS_BACKEND=memory was the root cause here). Refuse to boot rather
    // than run it in production; gated strictly on the prod signal so tests,
    // which legitimately use `memory`, are unaffected.
    if (isProductionDeployment(env) && resolveKmsBackend({ env }) === "memory") {
      throw new ElizaError(
        "Refusing to start with the ephemeral 'memory' KMS backend in production: " +
          "it rotates its key on every restart and orphans every record it encrypts. " +
          "Set ELIZA_KMS_BACKEND=local with a persistent ELIZA_LOCAL_ROOT_KEY (or " +
          "configure the steward backend).",
        {
          code: "KMS_MEMORY_BACKEND_IN_PRODUCTION",
          severity: "fatal",
          context: {
            backend: "memory",
            environment: env.ENVIRONMENT ?? env.NODE_ENV ?? null,
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
