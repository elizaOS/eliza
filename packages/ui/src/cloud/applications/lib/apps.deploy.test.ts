import { afterEach, describe, expect, it, vi } from "vitest";

// #9145 — deployApp's contract (endpoint + method) and gated-error propagation,
// without a network. Mock the typed api client the lib delegates to.
const apiMock = vi.fn();
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

const { checkAppNameAvailable, createApp, deleteApp, deployApp, updateApp } =
  await import("./apps");

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

describe("apps lib mutations (#9145)", () => {
  it("checkAppNameAvailable POSTs the name and coerces availability to a boolean", async () => {
    apiMock.mockResolvedValue({ available: true });
    await expect(checkAppNameAvailable("my-app")).resolves.toBe(true);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/check-name", {
      method: "POST",
      json: { name: "my-app" },
    });
    // A missing/undefined flag must read as unavailable, not truthy.
    apiMock.mockResolvedValue({});
    await expect(checkAppNameAvailable("x")).resolves.toBe(false);
  });

  it("createApp POSTs the input and returns the record + one-time key", async () => {
    apiMock.mockResolvedValue({ app: { id: "a" }, apiKey: "k" });
    const input = {
      name: "n",
      app_url: "https://x",
      allowed_origins: [],
    };
    await expect(createApp(input)).resolves.toEqual({
      app: { id: "a" },
      apiKey: "k",
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps", {
      method: "POST",
      json: input,
    });
  });

  it("updateApp PUTs the patch to /api/v1/apps/:id", async () => {
    apiMock.mockResolvedValue(undefined);
    await updateApp("app-1", { name: "renamed" });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app-1", {
      method: "PUT",
      json: { name: "renamed" },
    });
  });

  it("deleteApp DELETEs /api/v1/apps/:id", async () => {
    apiMock.mockResolvedValue(undefined);
    await deleteApp("app-1");
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app-1", {
      method: "DELETE",
    });
  });
});
