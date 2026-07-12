// @vitest-environment jsdom

/**
 * Unit coverage for `provisionCloudSandbox`'s create → provision request
 * chain: the immediate-bridge-url fast path, the shared-runtime adapter
 * derivation, and the create/provision HTTP failure boundaries. The
 * job-status polling branch (taken only when provisioning returns a jobId
 * with no immediate bridge URL) is exercised end-to-end against a real HTTP
 * server in client-cloud-connect-mock-cloud.test.ts via
 * `waitForCloudAgentRunning`'s sibling control-plane polling; it is not
 * duplicated here to avoid a slow 2s-interval timer test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches provisionCloudSandbox onto the prototype.
import "./client-cloud";

const CLOUD_API_BASE = "https://api.elizacloud.ai";

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    statusText: "",
  } as Response;
}

function routeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("provisionCloudSandbox", () => {
  let client: ElizaClient;

  beforeEach(() => {
    client = new ElizaClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns immediately when provisioning responds with a bridge URL (no polling)", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(200, { data: { id: "agent-1" } }),
        "/provision": () =>
          jsonResponse(200, {
            data: {
              bridgeUrl: "https://agent-1.elizacloud.ai/rpc",
              webUiUrl: "https://agent-1.elizacloud.ai",
              executionTier: "dedicated",
            },
          }),
      }),
    );
    const onProgress = vi.fn();
    const result = await client.provisionCloudSandbox({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      name: "Eliza",
      bio: ["An autonomous AI agent."],
      onProgress,
    });
    expect(result).toEqual({
      bridgeUrl: "https://agent-1.elizacloud.ai/rpc",
      agentId: "agent-1",
      webUiUrl: "https://agent-1.elizacloud.ai",
      executionTier: "dedicated",
    });
    expect(onProgress).toHaveBeenCalledWith("ready", "Sandbox ready!");
  });

  it("throws when agent creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(500, { message: "db unavailable" }),
      }),
    );
    await expect(
      client.provisionCloudSandbox({
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        name: "Eliza",
        bio: [],
      }),
    ).rejects.toThrow(/Failed to create cloud agent/);
  });

  it("throws when the create response has no agent id", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(200, {}),
      }),
    );
    await expect(
      client.provisionCloudSandbox({
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        name: "Eliza",
        bio: [],
      }),
    ).rejects.toThrow(/missing agent id/);
  });

  it("throws when starting provisioning fails", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(200, { data: { id: "agent-1" } }),
        "/provision": () => jsonResponse(502, { message: "bad gateway" }),
      }),
    );
    await expect(
      client.provisionCloudSandbox({
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        name: "Eliza",
        bio: [],
      }),
    ).rejects.toThrow(/Failed to start provisioning/);
  });

  it("rejects a shared-runtime response when the caller disallows shared runtime", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(200, { data: { id: "agent-1" } }),
        "/provision": () =>
          jsonResponse(200, { source: "shared_runtime", data: {} }),
      }),
    );
    await expect(
      client.provisionCloudSandbox({
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        name: "Eliza",
        bio: [],
      }),
    ).rejects.toThrow(/requires a dedicated sandbox/);
  });

  it("derives the REST-adapter web UI URL for an allowed shared-runtime agent with no server URL", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/agents": () => jsonResponse(200, { data: { id: "agent-1" } }),
        "/provision": () =>
          jsonResponse(200, { source: "shared_runtime", data: {} }),
      }),
    );
    const result = await client.provisionCloudSandbox({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      name: "Eliza",
      bio: [],
      allowSharedRuntime: true,
    });
    expect(result.executionTier).toBe("shared");
    expect(result.webUiUrl).toBe(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
    );
  });
});
