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

import { createKmsClient, type KmsClient } from "@elizaos/security/kms";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";

let _kms: KmsClient | null = null;

export function setKmsClient(client: KmsClient): void {
  _kms = client;
}

export function getKmsClient(): KmsClient {
  if (!_kms) {
    _kms = createKmsClient({ env: getCloudAwareEnv() });
  }
  return _kms;
}

/** Reset for tests only. */
export function resetKmsClientForTests(): void {
  _kms = null;
}
