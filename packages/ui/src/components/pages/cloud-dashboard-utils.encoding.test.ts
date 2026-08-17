/** Malformed github_error percent-encoding must not throw. */
// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("../../navigation", () => ({ pathForTab: () => "/settings" }));
vi.mock("../../utils/cloud-status", () => ({
  isCloudStatusReasonApiKeyOnly: () => false,
}));

import { consumeManagedGithubCallbackUrl } from "./cloud-dashboard-utils";

describe("consumeManagedGithubCallbackUrl encoding", () => {
  it("returns an error callback with null message for a lone %", () => {
    expect(() =>
      consumeManagedGithubCallbackUrl(
        "https://cloud.eliza.app/cloud?github_error=%",
      ),
    ).not.toThrow();
    const { callback } = consumeManagedGithubCallbackUrl(
      "https://cloud.eliza.app/cloud?github_error=%",
    );
    expect(callback).toEqual({
      status: "error",
      connectionId: null,
      agentId: null,
      message: null,
    });
  });

  it("returns an error callback with null message for %ZZ", () => {
    const { callback } = consumeManagedGithubCallbackUrl(
      "https://cloud.eliza.app/cloud?github_error=%ZZ",
    );
    expect(callback?.status).toBe("error");
    expect(callback?.message).toBeNull();
  });

  it("returns an error callback with null message for truncated UTF-8 %E0%A4%A", () => {
    const { callback } = consumeManagedGithubCallbackUrl(
      "https://cloud.eliza.app/cloud?github_error=%E0%A4%A",
    );
    expect(callback?.status).toBe("error");
    expect(callback?.message).toBeNull();
  });

  it("still decodes a valid %20 github_error", () => {
    const { callback } = consumeManagedGithubCallbackUrl(
      "https://cloud.eliza.app/cloud?github_error=repo%20missing",
    );
    expect(callback).toEqual({
      status: "error",
      connectionId: null,
      agentId: null,
      message: "repo missing",
    });
  });
});
