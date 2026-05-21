/**
 * Singleton accessor for the KMS client used by cloud-shared crypto helpers.
 *
 * Resolves the backend through `createKmsClient()` from `@elizaos/security`
 * (memory in tests, steward in prod, local for single-user desktop).
 *
 * In production, the steward backend requires `steward.baseUrl` +
 * `steward.tokenProvider`. Callers that bootstrap the worker runtime should
 * call `setKmsClient(...)` once at process start; otherwise the factory
 * default applies (memory in NODE_ENV=test, error in steward without config).
 */

import { createKmsClient, type KmsClient } from "@elizaos/security/kms";

let _kms: KmsClient | null = null;

export function setKmsClient(client: KmsClient): void {
  _kms = client;
}

export function getKmsClient(): KmsClient {
  if (!_kms) {
    _kms = createKmsClient();
  }
  return _kms;
}

/** Reset for tests only. */
export function resetKmsClientForTests(): void {
  _kms = null;
}
