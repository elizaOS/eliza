/**
 * Pins the two branches of the deferred guard's async disposal that decide
 * whether a strong credential proof is checked, skipped, or reported missing.
 * Both are reachable only through `Symbol.asyncDispose`, so no route test
 * exercises them directly.
 */

import { describe, expect, test } from "bun:test";
import { deferredCredentialAdmissionGuard } from "./deferred-credential-admission-guard";
import type { InferenceCredentialCheck } from "./inference-credential-revocation";

const CREDENTIAL: InferenceCredentialCheck = {
  kind: "api_key",
  credentialId: "cred_1",
  userId: "user_1",
};

async function disposeOf(guard: AsyncDisposable): Promise<void> {
  await guard[Symbol.asyncDispose]();
}

describe("deferredCredentialAdmissionGuard disposal", () => {
  test("a credential with no organization is reported, not silently dropped", async () => {
    const guard = deferredCredentialAdmissionGuard({
      organizationId: () => undefined,
      credential: () => CREDENTIAL,
    });

    await expect(disposeOf(guard)).rejects.toThrow(
      "Deferred inference credential is missing its organization",
    );
  });

  test("no credential means nothing to check, so no organization is required", async () => {
    const guard = deferredCredentialAdmissionGuard({
      organizationId: () => undefined,
      credential: () => undefined,
    });

    await expect(disposeOf(guard)).resolves.toBeUndefined();
  });

  test("taking the credential for admission suppresses the standalone check", async () => {
    const guard = deferredCredentialAdmissionGuard({
      organizationId: () => undefined,
      credential: () => CREDENTIAL,
    });

    expect(guard.credentialForAdmission()).toEqual(CREDENTIAL);
    await expect(disposeOf(guard)).resolves.toBeUndefined();
  });
});
