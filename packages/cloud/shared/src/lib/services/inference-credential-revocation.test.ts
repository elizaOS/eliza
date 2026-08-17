/** Verifies the fail-closed client contract for the inference revocation Durable Object. */

import { describe, expect, test } from "bun:test";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  assertInferenceCredentialActive,
  InferenceCredentialRevocationUnavailableError,
  InferenceCredentialRevokedError,
  revokeInferenceApiKey,
} from "./inference-credential-revocation";

const ENABLED = { INFERENCE_STRONG_REVOCATION_ENABLED: "true" };

describe("inference credential revocation client", () => {
  test("fails closed when the Durable Object binding is absent", async () => {
    await expect(
      runWithCloudBindingsAsync(ENABLED, () =>
        assertInferenceCredentialActive("org-1", {
          kind: "api_key",
          credentialId: "key-1",
          userId: "user-1",
        }),
      ),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);
  });

  test("maps an explicit Durable Object denial to a revoked decision", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json({ allowed: false, reason: "credential_revoked" }, { status: 403 }),
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        assertInferenceCredentialActive("org-1", {
          kind: "api_key",
          credentialId: "key-1",
          userId: "user-1",
        }),
      ),
    ).rejects.toBeInstanceOf(InferenceCredentialRevokedError);
  });

  test("requires a committed acknowledgement for revocation mutations", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ committed: false }),
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        revokeInferenceApiKey("org-1", "key-1"),
      ),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);
  });
});
