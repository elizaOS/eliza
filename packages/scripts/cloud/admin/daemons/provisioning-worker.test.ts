import { describe, expect, it, mock } from "bun:test";
import { assertProvisioningWorkerPreflight } from "./provisioning-worker";

describe("assertProvisioningWorkerPreflight", () => {
  it("verifies KMS can create or load the preflight key", async () => {
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await assertProvisioningWorkerPreflight({
      env: { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv,
      createKmsClient,
    });

    expect(createKmsClient).toHaveBeenCalledWith({
      env: { ELIZA_KMS_BACKEND: "local" },
    });
    expect(getOrCreateKey).toHaveBeenCalledWith(
      "system:provisioning-worker-preflight/v1",
    );
  });

  it("fails before the worker can heartbeat or claim jobs when KMS config is missing", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
        createKmsClient: () => {
          throw new Error(
            "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}",
          );
        },
      }),
    ).rejects.toThrow(
      "Refusing to publish a healthy heartbeat or claim provisioning jobs",
    );
  });

  it("fails when the selected KMS backend exists but cannot service key operations", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { ELIZA_KMS_BACKEND: "steward" } as NodeJS.ProcessEnv,
        createKmsClient: () => ({
          getOrCreateKey: async () => {
            throw new Error("Steward endpoint unavailable");
          },
        }),
      }),
    ).rejects.toThrow("Steward endpoint unavailable");
  });
});
