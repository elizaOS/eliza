import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectCloudCapabilitySandbox,
  provisionCloudCapabilitySandbox,
} from "./remote-capability-cloud-sandbox.ts";

const originalFetch = globalThis.fetch;

describe("cloud capability sandbox provisioner", () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("normalizes an immediate cloud capability endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/eliza/agents")) {
        return jsonResponse({ data: { id: "agent-1" } });
      }
      if (String(url).endsWith("/api/v1/eliza/agents/agent-1/provision")) {
        return jsonResponse({
          data: {
            capabilityRouterUrl: "https://capability.example.test/",
            capabilityRouterToken: "remote-token",
          },
        });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    });

    await expect(
      provisionCloudCapabilitySandbox({
        cloudApiBase: "https://www.elizacloud.ai",
        authToken: "cloud-token",
        name: "Capability Sandbox",
        bio: ["Builds remote plugins."],
        endpointId: "cloud-a",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      agentId: "agent-1",
      endpoint: {
        id: "cloud-a",
        baseUrl: "https://capability.example.test",
        token: "remote-token",
      },
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.elizacloud.ai/api/v1/eliza/agents",
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/provision",
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      agentName: "Capability Sandbox",
      agentConfig: { bio: ["Builds remote plugins."] },
    });
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer cloud-token",
    });
  });

  it("polls a job until the cloud capability endpoint is ready", async () => {
    vi.useFakeTimers();
    const progress: Array<{ status: string; detail?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/api/v1/eliza/agents")) {
        return jsonResponse({ id: "agent-2" });
      }
      if (href.endsWith("/api/v1/eliza/agents/agent-2/provision")) {
        return jsonResponse({ jobId: "job-2" });
      }
      if (href.endsWith("/api/v1/jobs/job-2")) {
        const jobPolls = fetchMock.mock.calls.filter(([calledUrl]) =>
          String(calledUrl).endsWith("/api/v1/jobs/job-2"),
        ).length;
        if (jobPolls === 1) {
          return jsonResponse({ status: "running" });
        }
        return jsonResponse({
          status: "completed",
          result: {
            capability_router_url: "https://job-capability.example.test",
            token: "job-token",
          },
        });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    });

    const resultPromise = provisionCloudCapabilitySandbox({
      cloudApiBase: "https://api.elizacloud.ai",
      authToken: "cloud-token",
      name: "Capability Sandbox",
      pollIntervalMs: 1000,
      timeoutMs: 10_000,
      fetch: fetchMock as unknown as typeof fetch,
      onProgress: (status, detail) => progress.push({ status, detail }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toEqual({
      agentId: "agent-2",
      jobId: "job-2",
      endpoint: {
        id: "cloud-capability",
        baseUrl: "https://job-capability.example.test",
        token: "job-token",
      },
    });
    expect(progress.map((item) => item.status)).toEqual([
      "creating",
      "provisioning",
      "provisioning",
      "ready",
    ]);
  });

  it("accepts bridgeUrl as a compatibility endpoint field", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/eliza/agents")) {
        return jsonResponse({ id: "agent-3" });
      }
      return jsonResponse({
        bridgeUrl: "https://legacy-bridge.example.test/",
      });
    });

    await expect(
      provisionCloudCapabilitySandbox({
        cloudApiBase: "https://api.elizacloud.ai",
        authToken: "cloud-token",
        name: "Legacy Bridge Sandbox",
        token: "override-token",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      agentId: "agent-3",
      endpoint: {
        id: "cloud-capability",
        baseUrl: "https://legacy-bridge.example.test",
        token: "override-token",
      },
    });
  });

  it("fails when provisioning completes without an endpoint", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/api/v1/eliza/agents")) {
        return jsonResponse({ id: "agent-4" });
      }
      if (href.endsWith("/api/v1/eliza/agents/agent-4/provision")) {
        return jsonResponse({ jobId: "job-4" });
      }
      return jsonResponse({ status: "completed", result: {} });
    });

    const resultPromise = provisionCloudCapabilitySandbox({
      cloudApiBase: "https://api.elizacloud.ai",
      authToken: "cloud-token",
      name: "Broken Sandbox",
      pollIntervalMs: 1000,
      timeoutMs: 1500,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const expectation = expect(resultPromise).rejects.toThrow(
      "Cloud capability sandbox provisioning timed out.",
    );
    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
  });

  it("connects a provisioned cloud endpoint and syncs remote plugins", async () => {
    const runtime = makeRuntime();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/v1/eliza/agents")) {
        return jsonResponse({ id: "agent-5" });
      }
      if (href.endsWith("/api/v1/eliza/agents/agent-5/provision")) {
        return jsonResponse({
          capabilityRouterUrl: "https://capability-cloud.example.test",
          capabilityRouterToken: "capability-token",
        });
      }
      if (
        href ===
          "https://capability-cloud.example.test/v1/capabilities/invoke" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as { method?: string };
        if (body.method === "plugin.modules.list") {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "cloud-capability-plugin",
                  name: "@remote/cloud-capability",
                  actions: [
                    {
                      name: "CLOUD_CAPABILITY_ACTION",
                      description: "Run cloud capability action.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (body.method === "plugin.action.invoke") {
          return jsonResponse({
            ok: true,
            result: { text: "cloud capability action" },
          });
        }
      }
      return jsonResponse({ error: `unexpected ${href}` }, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await connectCloudCapabilitySandbox(runtime, {
      cloudApiBase: "https://api.elizacloud.ai",
      authToken: "cloud-token",
      name: "Cloud Capability",
      allowedModuleIds: ["cloud-capability-plugin"],
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      agentId: "agent-5",
      endpoint: {
        id: "cloud-capability",
        baseUrl: "https://capability-cloud.example.test",
        token: "capability-token",
      },
      sync: {
        registered: [
          expect.objectContaining({ name: "@remote/cloud-capability" }),
        ],
        unloaded: [],
        skipped: [],
        trustDecisions: [
          {
            moduleId: "cloud-capability-plugin",
            pluginName: "@remote/cloud-capability",
            endpointId: "cloud-capability",
            trusted: true,
            reason: "allowed",
          },
        ],
      },
    });
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/cloud-capability",
    ]);
    await expect(
      runtime.actions[0]?.handler(runtime, {
        content: { text: "run" },
      } as never),
    ).resolves.toMatchObject({
      success: true,
      text: "cloud capability action",
    });
    const capabilityCalls = fetchMock.mock.calls.filter(
      ([url]) =>
        String(url) ===
        "https://capability-cloud.example.test/v1/capabilities/invoke",
    );
    expect(capabilityCalls).toHaveLength(2);
    expect(capabilityCalls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer capability-token",
    });
    expect(capabilityCalls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer capability-token",
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRuntime(): IAgentRuntime {
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Cloud Capability Test" },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
    providers: [] as NonNullable<Plugin["providers"]>,
    evaluators: [] as NonNullable<Plugin["evaluators"]>,
    routes: [] as NonNullable<Plugin["routes"]>,
    services: new Map() as IAgentRuntime["services"],
    getService: (serviceType: string) =>
      runtime.services.get(serviceType as never)?.[0] ?? null,
    getServicesByType: (serviceType: string) =>
      runtime.services.get(serviceType as never) ?? [],
    hasService: (serviceType: string) =>
      runtime.services.has(serviceType as never) ||
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE,
    registerPlugin: async (plugin: Plugin) => {
      runtime.plugins.push(plugin);
      runtime.actions.push(...(plugin.actions ?? []));
      runtime.providers.push(...(plugin.providers ?? []));
      runtime.evaluators.push(...(plugin.evaluators ?? []));
      runtime.routes.push(...(plugin.routes ?? []));
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () => [],
  } as Partial<IAgentRuntime> as IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    providers: NonNullable<Plugin["providers"]>;
    evaluators: NonNullable<Plugin["evaluators"]>;
    routes: NonNullable<Plugin["routes"]>;
  };
  return runtime;
}
