/** A revocation displaced into `SuppressedError.suppressed` keeps the credential contract. */

import { describe, expect, test } from "bun:test";
import { InferenceCredentialRevokedError } from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import { resolveInferenceCredentialAdmissionDenial } from "./generative-route-auth";

function suppressedError(error: unknown, suppressed: unknown): Error {
  return Object.assign(new Error("An error was suppressed during disposal."), {
    name: "SuppressedError",
    error,
    suppressed,
  });
}

describe("resolveInferenceCredentialAdmissionDenial", () => {
  test("unwraps a body revocation displaced by a later disposal failure", () => {
    // The route body failed with the revocation first; disposal then threw its
    // own error, so the revocation sits in `.suppressed`, not `.error`.
    const denial = resolveInferenceCredentialAdmissionDenial(
      suppressedError(
        new Error("organization unavailable"),
        new InferenceCredentialRevokedError("session_revoked"),
      ),
      { route: "displaced-revocation-test", traceId: "trace-displaced" },
    );
    expect(denial?.status).toBe(401);
    expect(denial?.reason).toBe("credential_inactive");
  });

  test("still unwraps a disposal revocation raised over a body failure", () => {
    const denial = resolveInferenceCredentialAdmissionDenial(
      suppressedError(
        new InferenceCredentialRevokedError("organization_disabled"),
        new Error("route body failed"),
      ),
    );
    expect(denial?.status).toBe(403);
    expect(denial?.reason).toBe("organization_inactive");
  });

  test("returns null when neither slot is a revocation", () => {
    expect(
      resolveInferenceCredentialAdmissionDenial(
        suppressedError(new Error("disposal"), new Error("body")),
      ),
    ).toBeNull();
  });
});
