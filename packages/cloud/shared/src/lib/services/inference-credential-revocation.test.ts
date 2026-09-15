/** Verifies the fail-closed client contract for the inference revocation Durable Object. */

import { describe, expect, test } from "bun:test";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  assertInferenceCredentialActive,
  InferenceCredentialRevocationUnavailableError,
  InferenceCredentialRevokedError,
  revokeInferenceApiKey,
  revokeInferenceSessionsThrough,
  setInferenceSessionBindingActive,
} from "./inference-credential-revocation";

const ENABLED = { INFERENCE_STRONG_REVOCATION_ENABLED: "true" };

describe("inference credential revocation client", () => {
  test("login and logout wait for a delayed durable acknowledgement", async () => {
    const committedPaths = new Set<string>();
    const namespace = {
      getByName: () => ({
        fetch: (request: Request) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              committedPaths.add(new URL(request.url).pathname);
              resolve(Response.json({ committed: true }));
            }, 2_000);
            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(request.signal.reason);
              },
              { once: true },
            );
          }),
      }),
    };
    await runWithCloudBindingsAsync(
      { ...ENABLED, INFERENCE_ADMISSION_GATES: namespace },
      async () => {
        await Promise.all([
          setInferenceSessionBindingActive("org-1", "user-1", "steward-1", true),
          revokeInferenceSessionsThrough("org-1", "user-1", 100),
        ]);
      },
    );
    expect(committedPaths.has("/session/set-binding-active")).toBe(true);
    expect(committedPaths.has("/session/revoke-through")).toBe(true);
  });

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

  test("never accepts a forbidden response as a committed mutation", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ committed: true }, { status: 403 }),
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        revokeInferenceApiKey("org-1", "key-1"),
      ),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);
  });

  test("maps structurally invalid JSON to the typed unavailable failure", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json(null),
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        revokeInferenceApiKey("org-1", "key-1"),
      ),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);
  });

  test("login activation preserves the missing-binding diagnosis", async () => {
    await expect(
      runWithCloudBindingsAsync(ENABLED, () =>
        setInferenceSessionBindingActive("org-private", "user-private", "steward-private", true),
      ),
    ).rejects.toThrow("Inference revocation Durable Object binding is missing");
  });

  test("login activation identifies lookup failures without exposing the cause message", async () => {
    const cause = new TypeError("private lookup metadata user-private");
    const namespace = {
      getByName: () => {
        throw cause;
      },
    };
    const activation = runWithCloudBindingsAsync(
      { ...ENABLED, INFERENCE_ADMISSION_GATES: namespace },
      () =>
        setInferenceSessionBindingActive("org-private", "user-private", "steward-private", true),
    );
    await expect(activation).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
      cause,
      message: "Inference revocation Durable Object lookup failed causeType=TypeError",
    });
  });

  test("login activation retains safe downstream failure flags and the original cause", async () => {
    const cause = Object.assign(new Error("private downstream metadata"), {
      retryable: true,
      overloaded: true,
      remote: true,
    });
    const namespace = {
      getByName: () => ({
        fetch: async () => {
          throw cause;
        },
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        setInferenceSessionBindingActive("org-private", "user-private", "steward-private", true),
      ),
    ).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
      cause,
      message:
        "Inference revocation boundary is unavailable deadlineExceeded=false causeType=Error retryable=true overloaded=true remote=true",
    });
  });

  test("login activation distinguishes its own deadline from an immediate transport error", async () => {
    const namespace = {
      getByName: () => ({
        fetch: (request: Request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          }),
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        setInferenceSessionBindingActive("org-private", "user-private", "steward-private", true),
      ),
    ).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
      message:
        "Inference revocation boundary is unavailable deadlineExceeded=true causeType=AbortError",
    });
  }, 15_000);

  test("request-time checks keep a short failure deadline", async () => {
    const namespace = {
      getByName: () => ({
        fetch: (request: Request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          }),
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
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);
  }, 4_000);

  test("failure diagnostics reject arbitrary labels and do not invoke custom flag getters", async () => {
    const cause = new Error("private cause message");
    cause.name = "private error name";
    Object.defineProperty(cause, "retryable", {
      get() {
        throw new Error("diagnostics must not invoke this getter");
      },
    });
    Object.defineProperty(cause, "overloaded", { value: "private flag value" });
    const namespace = {
      getByName: () => ({
        fetch: async () => {
          throw cause;
        },
      }),
    };
    await expect(
      runWithCloudBindingsAsync({ ...ENABLED, INFERENCE_ADMISSION_GATES: namespace }, () =>
        setInferenceSessionBindingActive("org-private", "user-private", "steward-private", true),
      ),
    ).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
      cause,
      message:
        "Inference revocation boundary is unavailable deadlineExceeded=false causeType=Error",
    });
  });
});
