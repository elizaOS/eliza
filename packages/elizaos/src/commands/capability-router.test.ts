import { afterEach, describe, expect, it, vi } from "vitest";
import { runCapabilityRouterConnect } from "./capability-router";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function mockFetch(response: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(response)),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("runCapabilityRouterConnect", () => {
  it("posts a direct endpoint payload to the local agent API", async () => {
    const fetchMock = mockFetch({
      success: true,
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test",
        hasToken: true,
      },
      sync: { registered: ["remote-plugin"], unloaded: [], skipped: [] },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      apiBase: "http://127.0.0.1:31337/",
      apiToken: "api-secret",
      endpointUrl: "https://capability.example.test/",
      endpointId: "tools",
      endpointToken: "endpoint-secret",
      requestTimeoutMs: "15000",
      allowedModule: ["remote-plugin", "remote-plugin", " other-plugin "],
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/capability-router/connect",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer api-secret",
        },
        body: JSON.stringify({
          unloadMissing: true,
          persist: true,
          allowedModuleIds: ["remote-plugin", "other-plugin"],
          requestTimeoutMs: 15000,
          endpoint: {
            baseUrl: "https://capability.example.test",
            id: "tools",
            token: "endpoint-secret",
          },
        }),
      },
    );
    expect(log.mock.calls.join("\n")).toContain("Capability router connected");
  });

  it("posts Cloud provisioning options and can keep missing plugins", async () => {
    const fetchMock = mockFetch({
      success: true,
      agentId: "agent-1",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        hasToken: true,
      },
      sync: { registered: [], unloaded: [], skipped: [] },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      cloudApiBase: "https://cloud.example.test/",
      cloudAuthToken: "cloud-auth",
      cloudAgentName: "Remote Tools",
      cloudBio: ["runs dynamic tools"],
      endpointId: "cloud",
      cloudEndpointToken: "endpoint-token",
      provisionTimeoutMs: "5000",
      pollIntervalMs: "100",
      allowedModule: ["cloud-plugin"],
      keepMissing: true,
      json: true,
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:2138/api/capability-router/connect",
      expect.objectContaining({
        body: JSON.stringify({
          unloadMissing: false,
          persist: true,
          allowedModuleIds: ["cloud-plugin"],
          cloud: {
            cloudApiBase: "https://cloud.example.test",
            authToken: "cloud-auth",
            name: "Remote Tools",
            bio: ["runs dynamic tools"],
            endpointId: "cloud",
            token: "endpoint-token",
            timeoutMs: 5000,
            pollIntervalMs: 100,
            allowedModuleIds: ["cloud-plugin"],
          },
        }),
      }),
    );
  });

  it("can request an ephemeral direct connection", async () => {
    const fetchMock = mockFetch({
      success: true,
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test",
        hasToken: false,
      },
      sync: { registered: [], unloaded: [], skipped: [] },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
      persist: false,
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:2138/api/capability-router/connect",
      expect.objectContaining({
        body: JSON.stringify({
          unloadMissing: true,
          persist: false,
          endpoint: {
            baseUrl: "https://capability.example.test",
          },
        }),
      }),
    );
  });

  it("rejects missing endpoint and cloud options before calling the API", async () => {
    const fetchMock = mockFetch({ success: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({});

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain(
      "Provide --endpoint-url or Cloud provisioning options.",
    );
  });

  it.each([
    ["cloudApiBase", { cloudApiBase: "https://cloud.example.test" }],
    ["cloudAuthToken", { cloudAuthToken: "cloud-auth" }],
    ["cloudAgentName", { cloudAgentName: "Cloud Agent" }],
    ["cloudBio", { cloudBio: ["runs tools"] }],
    ["cloudEndpointToken", { cloudEndpointToken: "endpoint-token" }],
    ["provisionTimeoutMs", { provisionTimeoutMs: "1000" }],
    ["pollIntervalMs", { pollIntervalMs: "100" }],
  ])("rejects endpoint URL mixed with cloud-only option %s before calling the API", async (_name, cloudOnlyOption) => {
    const fetchMock = mockFetch({ success: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
      ...cloudOnlyOption,
    });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain(
      "Use either --endpoint-url or --cloud-api-base, not both.",
    );
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "1e3",
    "0x10",
    "1_000",
    "Infinity",
  ])("rejects non-decimal positive request timeout %s before calling the API", async (requestTimeoutMs) => {
    const fetchMock = mockFetch({ success: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
      requestTimeoutMs,
    });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain(
      "request timeout must be a positive integer.",
    );
  });

  it("surfaces API errors without leaking request tokens", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      apiToken: "api-secret",
      endpointUrl: "https://capability.example.test",
      endpointToken: "endpoint-secret",
    });

    expect(code).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("Unauthorized");
    expect(JSON.stringify(error.mock.calls)).not.toContain("api-secret");
    expect(JSON.stringify(error.mock.calls)).not.toContain("endpoint-secret");
  });
});
