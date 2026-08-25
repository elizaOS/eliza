import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCloudRelayRoute } from "./cloud-relay-routes";

interface JsonCall {
  body: Record<string, unknown>;
}

function makeHelpers() {
  const calls: JsonCall[] = [];
  const helpers = {
    json: (_res: unknown, body: Record<string, unknown>) => {
      calls.push({ body });
    },
  };
  return { calls, helpers };
}

const req = {} as never;

describe("cloud relay status route", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false for a non-matching path", async () => {
    const { calls, helpers } = makeHelpers();
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/other",
      "GET",
      { runtime: {} },
      helpers as never,
    );
    expect(handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false for a non-GET method", async () => {
    const { calls, helpers } = makeHelpers();
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "POST",
      { runtime: {} },
      helpers as never,
    );
    expect(handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports no_runtime when the runtime is not initialized", async () => {
    const { calls, helpers } = makeHelpers();
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      {},
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body).toMatchObject({
      available: false,
      status: "no_runtime",
    });
  });

  it("reports not_registered when no known service name resolves", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => undefined),
    };
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(runtime.getService).toHaveBeenCalledTimes(3);
    expect(calls[0].body).toMatchObject({
      available: false,
      status: "not_registered",
    });
  });

  it("reports not_registered when the resolved service lacks getSessionInfo", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => ({})),
    };
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body.status).toBe("not_registered");
  });

  it("degrades to an error state when the service registry throws", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => {
        throw new Error("service registry unavailable");
      }),
    };
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body).toMatchObject({
      available: false,
      status: "error",
    });
  });

  it("renders an error state when getSessionInfo throws", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => ({
        getSessionInfo: () => {
          throw new Error("session store down");
        },
      })),
    };
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body).toMatchObject({
      available: false,
      status: "error",
      reason: "session store down",
    });
  });

  it("serves session info with an access URL when registered", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => undefined),
      getSetting: vi.fn(() => null),
    };
    runtime.getService.mockImplementation((name: string) => {
      if (name === "CLOUD_MANAGED_GATEWAY_RELAY") {
        return {
          getSessionInfo: () => ({
            sessionId: "sess-1",
            organizationId: "org-1",
            userId: "user-1",
            agentName: "agent-1",
            platform: "telegram",
            lastSeenAt: "2026-08-25T00:00:00.000Z",
            status: "registered",
          }),
        };
      }
      return undefined;
    });
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://runner.example.com");
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body.available).toBe(true);
    expect(calls[0].body.status).toBe("registered");
    expect(calls[0].body.sessionId).toBe("sess-1");
    expect(String(calls[0].body.accessUrl)).toContain(
      "homeRemoteRunnerSession=sess-1",
    );
  });

  it("prefers runtime settings over env and trims whitespace for the ssh tunnel", async () => {
    const { calls, helpers } = makeHelpers();
    const runtime = {
      getService: vi.fn(() => undefined),
      getSetting: vi.fn((key: string) => {
        if (key === "ELIZA_HOME_REMOTE_RUNNER_SSH_TARGET") {
          return "  runner@example.com  ";
        }
        return null;
      }),
    };
    runtime.getService.mockImplementation((name: string) => {
      if (name === "CLOUD_MANAGED_GATEWAY_RELAY") {
        return {
          getSessionInfo: () => ({
            sessionId: "sess-2",
            organizationId: null,
            userId: null,
            agentName: null,
            platform: null,
            lastSeenAt: null,
            status: "polling",
          }),
        };
      }
      return undefined;
    });
    vi.stubEnv("ELIZA_HOME_REMOTE_RUNNER_URL", "http://runner.example.com:2222");
    const handled = await handleCloudRelayRoute(
      req,
      {} as never,
      "/api/cloud/relay-status",
      "GET",
      { runtime },
      helpers as never,
    );
    expect(handled).toBe(true);
    expect(calls[0].body.status).toBe("polling");
    const ssh = calls[0].body.ssh as { command: string; localUrl: string };
    expect(ssh.command).toContain("runner@example.com");
    expect(ssh.command).toContain("127.0.0.1:2222");
    expect(ssh.localUrl).toContain("127.0.0.1:2222");
  });
});
