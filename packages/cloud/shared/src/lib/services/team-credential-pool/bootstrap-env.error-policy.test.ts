/**
 * Error-policy guard for the pooled-credential bootstrap merge (#13415): a
 * genuine registry fault must PROPAGATE (never be swallowed into the agent's
 * unchanged env), while a legitimately-empty pool (no eligible credential)
 * still returns the designed unchanged env — the two are distinguishable.
 * Deterministic: the registry is mocked so `selectCredential` can be driven to
 * return `null`, resolve a credential, or throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectCredential = vi.fn();
const recordUse = vi.fn();

vi.mock("./registry", () => ({
  getTeamPoolRegistry: () => ({ selectCredential, recordUse }),
}));

import { applyPooledCredentialsToBootstrapEnv } from "./bootstrap-env";

describe("applyPooledCredentialsToBootstrapEnv error policy", () => {
  beforeEach(() => {
    selectCredential.mockReset();
    recordUse.mockReset();
  });

  it("legitimately-empty pool returns the env unchanged (designed empty, not a failure)", async () => {
    selectCredential.mockResolvedValue(null);
    const env = { FOO: "bar" };

    const out = await applyPooledCredentialsToBootstrapEnv({
      organizationId: "org-1",
      userId: "user-1",
      sessionKey: "sess-1",
      env,
    });

    // The real select path was driven, produced no credential, and left env intact.
    expect(selectCredential).toHaveBeenCalled();
    expect(out).toEqual({ FOO: "bar" });
    expect(recordUse).not.toHaveBeenCalled();
  });

  it("propagates an internal registry fault instead of falling back to the raw env", async () => {
    selectCredential.mockRejectedValue(new Error("vault decrypt failed"));
    const env = { FOO: "bar" };

    await expect(
      applyPooledCredentialsToBootstrapEnv({
        organizationId: "org-1",
        userId: "user-1",
        sessionKey: "sess-1",
        env,
      }),
    ).rejects.toThrow("vault decrypt failed");
  });

  it("merges a selected pooled key and attributes the use", async () => {
    selectCredential.mockImplementation(async ({ providerId }: { providerId: string }) =>
      providerId === "anthropic-api" ? { credentialId: "cred-1", apiKey: "sk-ant-pooled" } : null,
    );
    recordUse.mockResolvedValue(undefined);

    const out = await applyPooledCredentialsToBootstrapEnv({
      organizationId: "org-1",
      userId: "user-1",
      sessionKey: "sess-1",
      env: {},
    });

    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-pooled");
    expect(recordUse).toHaveBeenCalledWith({
      organizationId: "org-1",
      credentialId: "cred-1",
      userId: "user-1",
    });
  });
});
