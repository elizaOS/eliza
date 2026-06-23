import { afterEach, describe, expect, it, vi } from "vitest";

// #9145 — deployApp's contract (endpoint + method) and gated-error propagation,
// without a network. Mock the typed api client the lib delegates to.
const apiMock = vi.fn();
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

const { deployApp } = await import("./apps");

afterEach(() => {
  apiMock.mockReset();
});

describe("deployApp (#9145)", () => {
  it("POSTs to /api/v1/apps/:id/deploy and returns the deployment record", async () => {
    apiMock.mockResolvedValue({ deploymentId: "dep_1", status: "building" });
    const result = await deployApp("app_42");
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_42/deploy", {
      method: "POST",
    });
    expect(result).toEqual({ deploymentId: "dep_1", status: "building" });
  });

  it("propagates the gated apps_deploy_disabled error to the caller", async () => {
    apiMock.mockRejectedValue(new Error("apps_deploy_disabled"));
    await expect(deployApp("app_42")).rejects.toThrow("apps_deploy_disabled");
  });
});
