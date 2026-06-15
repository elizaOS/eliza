import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeploy } from "./deploy";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("runDeploy", () => {
  it("keeps dry-run mode network-free", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({ dryRun: true, appId: "app-1" });

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues a cloud deploy and polls to READY", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test/api/v1";
    process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { success: true, deploymentId: "dep-1", status: "BUILDING" },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          deploymentId: "dep-1",
          status: "READY",
          vercelUrl: "https://app.example.vercel.app",
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({ appId: "app-1" });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/deploy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer eliza_test_key",
          "Content-Type": "application/json; charset=utf-8",
        }),
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/deploy/status",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer eliza_test_key" },
      }),
    );
  });

  it("attaches a custom domain after queueing the deploy", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
    process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { success: true, deploymentId: "dep-1", status: "BUILDING" },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          verified: false,
          verificationRecord: {
            type: "TXT",
            name: "_eliza.example.com",
            value: "eliza-verify-token",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          deploymentId: "dep-1",
          status: "READY",
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({
      appId: "app-1",
      domain: "agent.example.com",
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/domains",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ domain: "agent.example.com" }),
      }),
    );
  });

  it("fails real deploys without cloud credentials", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_CLOUD_API_KEY;
    delete process.env.ELIZACLOUD_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runDeploy({ appId: "app-1" });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
