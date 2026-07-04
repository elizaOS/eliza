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
  deployRepoUrlFromApp,
  deployApp,
  getLatestAppDeployment,
  regenerateAppApiKey,
  updateApp,
  validateDeployAppInput,
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

  it("POSTs a repository source payload when the app shell supplies one", async () => {
    apiMock.mockResolvedValue({ deploymentId: "dep_2", status: "BUILDING" });
    const input = {
      repoUrl: "https://github.com/elizaOS/eliza.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      dockerfile: "packages/examples/cloud/Dockerfile",
    };

    await deployApp("app_42", input);

    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_42/deploy", {
      method: "POST",
      json: input,
    });
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

describe("deploy app source validation (#13425)", () => {
  it("accepts an http(s) repository URL, full commit SHA, and optional Dockerfile", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "0123456789abcdef0123456789abcdef01234567",
        dockerfile: "packages/examples/cloud/Dockerfile",
      }),
    ).toEqual({
      ok: true,
      value: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "0123456789abcdef0123456789abcdef01234567",
        dockerfile: "packages/examples/cloud/Dockerfile",
      },
    });
  });

  it("normalizes a stored GitHub owner/repo value for the form", () => {
    expect(
      deployRepoUrlFromApp({
        id: "app_42",
        github_repo: "elizaOS/eliza",
      } as never),
    ).toBe("https://github.com/elizaOS/eliza.git");
  });

  it("rejects mutable refs and non-http repository URLs", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "git@github.com:elizaOS/eliza.git",
        ref: "develop",
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateDeployAppInput({
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
      }),
    ).toMatchObject({
      ok: false,
      error:
        "Use a full 40-character commit SHA so the cloud build is immutable.",
    });
  });

  it("rejects unsupported bundle/image deploy inputs", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "0123456789abcdef0123456789abcdef01234567",
        zip: "file.zip",
      }),
    ).toMatchObject({
      ok: false,
      error:
        "Deploy from a Git repository and immutable commit SHA. Source bundles, images, zips, tars, and artifacts are not supported.",
    });
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
