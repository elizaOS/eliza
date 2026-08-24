/**
 * Command-barrel tests exercise the public surface consumed from
 * ./commands/index.js by the library entry (src/index.ts) and the CLI
 * (src/cli.ts): every re-export must resolve to a live runtime binding, and a
 * real capability-router connect flow is driven through the barrel with fetch
 * stubbed at the process boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilityRouterConnect,
  create,
  DEPLOY_COMMAND_DESCRIPTION,
  DEPLOY_DRY_RUN_DESCRIPTION,
  deploy,
  info,
  migrateAgent,
  registerPluginsCommand,
  runCapabilityRouterConnect,
  runDeploy,
  submitPluginToRegistry,
  upgrade,
  version,
} from "./index";

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

describe("command barrel", () => {
  it("resolves every library and CLI consumer export to a live binding", () => {
    // src/index.ts and src/cli.ts import these names from this barrel; a
    // broken re-export chain surfaces as an undefined binding at runtime even
    // while the types still compile.
    for (const command of [
      capabilityRouterConnect,
      create,
      deploy,
      info,
      migrateAgent,
      registerPluginsCommand,
      runCapabilityRouterConnect,
      runDeploy,
      submitPluginToRegistry,
      upgrade,
      version,
    ]) {
      expect(command).toBeTypeOf("function");
    }
    expect(DEPLOY_COMMAND_DESCRIPTION.trim()).not.toBe("");
    expect(DEPLOY_DRY_RUN_DESCRIPTION.trim()).not.toBe("");
  });

  it("prefers ELIZA_API_BASE_URL over ELIZA_API_BASE and omits the authorization header without a token", async () => {
    process.env.ELIZA_API_BASE_URL = "http://env-base.example.test:4001/";
    process.env.ELIZA_API_BASE = "http://fallback.example.test:4002";
    delete process.env.ELIZA_API_TOKEN;
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
      endpointUrl: "https://capability.example.test/",
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://env-base.example.test:4001/api/capability-router/connect",
    );
    expect(init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
  });

  it("builds the default base from ELIZA_API_PORT over ELIZA_PORT and trims the bearer token", async () => {
    delete process.env.ELIZA_API_BASE_URL;
    delete process.env.ELIZA_API_BASE;
    process.env.ELIZA_API_PORT = "4599";
    process.env.ELIZA_PORT = "4600";
    process.env.ELIZA_API_TOKEN = "  api-secret  ";
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
    });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4599/api/capability-router/connect");
    expect(init.headers).toMatchObject({
      authorization: "Bearer api-secret",
    });
  });

  it("fails with exit code 1 when the agent API is unreachable", async () => {
    delete process.env.ELIZA_API_TOKEN;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
    });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "Failed to call agent API: connection refused",
    );
  });

  it("emits machine-parseable JSON on stdout for a failed --json run without touching stderr", async () => {
    delete process.env.ELIZA_API_TOKEN;
    mockFetch({ error: "Unauthorized" }, 403);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
      json: true,
    });

    expect(code).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls.join("\n")) as {
      error?: string;
    };
    expect(payload.error).toBe("Unauthorized");
  });

  it("echoes the full agent response as JSON on a successful --json run", async () => {
    delete process.env.ELIZA_API_TOKEN;
    const responseBody = {
      success: true,
      agentId: "agent-9",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        hasToken: true,
      },
      sync: { registered: ["a-plugin"], unloaded: [], skipped: [] },
    };
    mockFetch(responseBody);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCapabilityRouterConnect({
      endpointUrl: "https://capability.example.test",
      json: true,
    });

    expect(code).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls.join("\n"))).toEqual(responseBody);
  });
});
