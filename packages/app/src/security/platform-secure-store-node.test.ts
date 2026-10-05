import { describe, expect, it } from "vitest";
import { createNodePlatformSecureStore } from "./platform-secure-store-node";

describe("Linux secure-store failure receipts", () => {
  it.each([null, undefined, 42])(
    "handles non-Error rejection %s",
    async (failure) => {
      const store = createNodePlatformSecureStore({
        platform: "linux",
        runSecretTool: async () => {
          throw failure;
        },
      });
      await expect(
        store.get("test-vault", "session.device_auth"),
      ).resolves.toEqual({
        ok: false,
        reason: "error",
        message: "Native credential store operation failed.",
      });
    },
  );

  it("retains the empty lookup exit receipt as not found", async () => {
    const store = createNodePlatformSecureStore({
      platform: "linux",
      runSecretTool: async () => {
        throw Object.assign(new Error("lookup failed"), {
          code: 1,
          stderr: "",
        });
      },
    });
    await expect(
      store.get("test-vault", "session.device_auth"),
    ).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
