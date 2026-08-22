/** Verifies the credential precedence used by native Cloud settings. */
import { describe, expect, it } from "vitest";
import { resolveCloudManagementToken } from "./cloud-management-auth";

describe("resolveCloudManagementToken", () => {
  it("prefers the independently scoped Steward session", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: " steward-jwt ",
        bootApiToken: "eliza_boot-owner-key",
        runtimeApiToken: "eliza_runtime-owner-key",
      }),
    ).toBe("steward-jwt");
  });

  it("accepts the owner API key returned by desktop device-code login", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: null,
        bootApiToken: "eliza_boot-owner-key",
        runtimeApiToken: null,
      }),
    ).toBe("eliza_boot-owner-key");
  });

  it("rejects unrelated agent bearer strings", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: null,
        bootApiToken: "container-bearer",
        runtimeApiToken: "not-an-owner-key",
      }),
    ).toBe("");
  });
});
