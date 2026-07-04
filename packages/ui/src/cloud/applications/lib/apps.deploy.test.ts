/**
 * Unit coverage for deployApp's contract (endpoint/method, gated-error
 * propagation) against a mocked api client, no network (#9145).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// #9145 — deployApp's contract (endpoint + method) and gated-error propagation,
// without a network. Mock the typed api client the lib delegates to.
const apiMock = vi.fn();
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

const {
  checkAppNameAvailable,
  createApp,
  deleteApp,
  deployApp,
  getLatestAppDeployment,
  regenerateAppApiKey,
  updateApp,
} = await import("./apps");

afterEach(() => {
  apiMock.mockReset();
});

describe("deployApp (#9145)", () => {
  it("POSTs to /api/v1/apps/:id/deploy and returns the deployment record", async () => {
    apiMock.mockResolvedValue({ deploymentId: "dep_1", status: "BUILDING" });
    const result = await deployApp("app_42");
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_42/deploy", {
      method: "POST",
    });
    expect(result).toEqual({ deploymentId: "dep_1", status: "BUILDING" });
  });

  it("propagates the gated apps_deploy_disabled error to the caller", async () => {
    apiMock.mockRejectedValue(new Error("apps_deploy_disabled"));
    await expect(deployApp("app_42")).rejects.toThrow("apps_deploy_disabled");
  });

  it("GETs /api/v1/apps/:id/deploy/status for dashboard polling", async () => {
    apiMock.mockResolvedValue({
      success: true,
      deploymentId: "dep_1",
      status: "READY",
      vercelUrl: "https://app.example.test",
      error: null,
      startedAt: "2026-06-24T12:00:00.000Z",
    });

    const result = await getLatestAppDeployment("app_42");

    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_42/deploy/status");
    expect(result.status).toBe("READY");
    expect(result.vercelUrl).toBe("https://app.example.test");
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

  it("createApp POSTs the input with skipGitHubRepo:true (deployable template app) and returns the record + one-time key", async () => {
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
    // The dashboard front door MUST request a template app so the server stamps
    // a deployable image — otherwise the created app has no image and DEPLOY
    // throws "build-from-repo is disabled / no image to deploy".
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps", {
      method: "POST",
      json: { skipGitHubRepo: true, ...input },
    });
  });

  it("createApp leaves an explicit skipGitHubRepo:false intact (caller override)", async () => {
    apiMock.mockResolvedValue({ app: { id: "a" }, apiKey: "k" });
    const input = {
      name: "n",
      app_url: "https://x",
      allowed_origins: [],
      skipGitHubRepo: false,
    };
    await createApp(input);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps", {
      method: "POST",
      json: {
        skipGitHubRepo: false,
        name: "n",
        app_url: "https://x",
        allowed_origins: [],
      },
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

  it("regenerateAppApiKey returns the rotated key", async () => {
    apiMock.mockResolvedValue({ apiKey: "eliza_new" });
    await expect(regenerateAppApiKey("app-1")).resolves.toBe("eliza_new");
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/apps/app-1/regenerate-api-key",
      { method: "POST" },
    );
  });

  it("regenerateAppApiKey throws when the response omits a usable key", async () => {
    apiMock.mockResolvedValue({});
    await expect(regenerateAppApiKey("app-1")).rejects.toThrow(
      "did not include an API key",
    );
    apiMock.mockResolvedValue({ apiKey: "" });
    await expect(regenerateAppApiKey("app-1")).rejects.toThrow();
  });
});
