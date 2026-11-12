/** Ensures every deferred strong credential proof reaches exactly one admission boundary. */

import type { InferenceCredentialCheck } from "./inference-credential-revocation";

/**
 * Routes pass `credentialForAdmission()` to each atomic paid admission. Any
 * return or throw before the first admission performs the standalone strong
 * check during async disposal; multi-operation routes reuse the exact proof.
 */
export function deferredCredentialAdmissionGuard(params: {
  organizationId(): string | undefined;
  credential(): InferenceCredentialCheck | undefined;
}) {
  let admissionStarted = false;
  return {
    credentialForAdmission(): InferenceCredentialCheck | undefined {
      admissionStarted = true;
      return params.credential();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      const credential = params.credential();
      if (admissionStarted || !credential) return;
      const organizationId = params.organizationId();
      if (!organizationId) {
        throw new Error("Deferred inference credential is missing its organization");
      }
      const { assertInferenceCredentialActive } = await import("./inference-credential-revocation");
      await assertInferenceCredentialActive(organizationId, credential);
    },
  };
}
