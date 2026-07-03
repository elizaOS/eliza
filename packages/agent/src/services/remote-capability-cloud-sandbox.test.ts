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
  waitForCloudCapabilityEndpointAvailability,
} from "./remote-capability-cloud-sandbox.ts";
import type { RemoteCapabilityRouterService } from "./remote-capability-router.ts";

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
      statefulRuntime: true,
      agentConfig: { bio: ["Builds remote plugins."] },
    });
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer cloud-token",
    });
  });

  it("polls a job until the cloud capability endpoint is ready", async () => {
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
      pollIntervalMs: 1,
      timeoutMs: 10_000,
      fetch: fetchMock as unknown as typeof fetch,
      onProgress: (status, detail) => progress.push({ status, detail }),
    });

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

  it("waits until a cloud capability endpoint reports plugin availability", async () => {
    const progress: string[] = [];
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        const attempt = fetchMock.mock.calls.length;
        if (attempt === 1) {
          return jsonResponse({
            available: false,
            capabilities: { plugin: false },
          });
        }
        return jsonResponse({
          available: true,
          capabilities: { plugin: true },
        });
      },
    );

    await expect(
      waitForCloudCapabilityEndpointAvailability({
        endpoint: {
          id: "cloud-capability",
          baseUrl: "https://capability.example.test",
          token: "capability-token",
        },
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        requestTimeoutMs: 1_000,
        fetch: fetchMock as unknown as typeof fetch,
        onProgress: (detail) => progress.push(detail),
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://capability.example.test/v1/capabilities"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer capability-token",
      },
    });
    expect(progress[0]).toContain("unexpected availability payload");
  });

  it("reports the last readiness failure when cloud availability never starts", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "not ready" }, 503),
    );

    await expect(
      waitForCloudCapabilityEndpointAvailability({
        endpoint: {
          id: "cloud-capability",
          baseUrl: "https://capability.example.test",
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        requestTimeoutMs: 1_000,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(
      'Cloud capability endpoint cloud-capability did not report plugin availability within 1ms. Last error: HTTP 503: {"error":"not ready"}',
    );
  });

  it("fails when provisioning completes without an endpoint", async () => {
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
      pollIntervalMs: 1,
      timeoutMs: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(resultPromise).rejects.toThrow(
      "Cloud capability sandbox provisioning timed out.",
    );
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
                  providers: [
                    {
                      name: "CLOUD_CAPABILITY_CONTEXT",
                      description: "Cloud capability context.",
                    },
                  ],
                  evaluators: [
                    {
                      name: "CLOUD_CAPABILITY_EVALUATOR",
                      description: "Cloud capability evaluator.",
                      prompt: "Evaluate cloud capability state.",
                      schema: { type: "object", properties: {} },
                      hasPrepare: true,
                      hasProcessor: true,
                    },
                  ],
                  responseHandlerEvaluators: [
                    {
                      name: "CLOUD_CAPABILITY_RESPONSE_EVALUATOR",
                      description: "Cloud response evaluator.",
                    },
                  ],
                  responseHandlerFieldEvaluators: [
                    {
                      name: "cloud_status",
                      description: "Cloud status field evaluator.",
                      schema: { type: "object", properties: {} },
                      hasParse: true,
                      hasHandle: true,
                    },
                  ],
                  models: [
                    {
                      modelType: "CLOUD_TEXT",
                      priority: 40,
                    },
                  ],
                  lifecycle: {
                    hooks: ["init", "dispose", "applyConfig"],
                  },
                  events: [
                    {
                      eventName: "cloud.capability.event",
                    },
                  ],
                  services: [
                    {
                      serviceType: "cloud-capability-service",
                      capabilityDescription: "Cloud capability service.",
                      methods: ["ping"],
                    },
                  ],
                  appBridge: {
                    hooks: ["prepareLaunch"],
                  },
                  routes: [
                    {
                      method: "POST",
                      path: "/cloud/capability",
                      public: true,
                      name: "cloud-capability-route",
                      publicReason:
                        "Remote cloud sandbox fixture public route.",
                    },
                  ],
                  views: [
                    {
                      id: "cloud-capability.view",
                      label: "Cloud Capability",
                      bundlePath: "/assets/cloud-capability.js",
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
        if (body.method === "plugin.provider.get") {
          return jsonResponse({
            ok: true,
            result: {
              text: "cloud capability provider",
              values: { source: "cloud" },
            },
          });
        }
        if (body.method === "plugin.evaluator.shouldRun") {
          return jsonResponse({
            ok: true,
            result: { shouldRun: true },
          });
        }
        if (body.method === "plugin.evaluator.prepare") {
          return jsonResponse({
            ok: true,
            result: { prepared: { cloudPrepared: true } },
          });
        }
        if (body.method === "plugin.evaluator.prompt") {
          return jsonResponse({
            ok: true,
            result: { prompt: "cloud evaluator prompt" },
          });
        }
        if (body.method === "plugin.evaluator.process") {
          return jsonResponse({
            ok: true,
            result: { result: { cloudProcessed: true } },
          });
        }
        if (body.method === "plugin.responseHandlerEvaluator.shouldRun") {
          return jsonResponse({
            ok: true,
            result: { shouldRun: true },
          });
        }
        if (body.method === "plugin.responseHandlerEvaluator.evaluate") {
          return jsonResponse({
            ok: true,
            result: { patch: { cloudResponse: true } },
          });
        }
        if (body.method === "plugin.responseHandlerFieldEvaluator.shouldRun") {
          return jsonResponse({
            ok: true,
            result: { shouldRun: true },
          });
        }
        if (body.method === "plugin.responseHandlerFieldEvaluator.parse") {
          return jsonResponse({
            ok: true,
            result: { value: { cloudParsed: true } },
          });
        }
        if (body.method === "plugin.responseHandlerFieldEvaluator.handle") {
          return jsonResponse({
            ok: true,
            result: { effect: { patch: { cloudHandled: true } } },
          });
        }
        if (body.method === "plugin.model.invoke") {
          return jsonResponse({
            ok: true,
            result: { result: { cloudModel: true } },
          });
        }
        if (body.method === "plugin.lifecycle.call") {
          return jsonResponse({
            ok: true,
            result: { ok: true },
          });
        }
        if (body.method === "plugin.event.handle") {
          return jsonResponse({
            ok: true,
            result: { handled: true },
          });
        }
        if (body.method === "plugin.service.call") {
          return jsonResponse({
            ok: true,
            result: { result: { cloudService: true } },
          });
        }
        if (body.method === "plugin.appBridge.call") {
          return jsonResponse({
            ok: true,
            result: { result: { handled: true, body: { cloudBridge: true } } },
          });
        }
        if (body.method === "plugin.route.call") {
          return jsonResponse({
            ok: true,
            result: {
              status: 202,
              headers: { "x-cloud-capability": "yes" },
              body: { routed: true },
            },
          });
        }
        if (body.method === "plugin.asset.get") {
          return jsonResponse({
            ok: true,
            result: {
              path: "/assets/cloud-capability.js",
              contentType: "text/javascript",
              bodyBase64: Buffer.from(
                "export const cloudCapabilityView = true;",
              ).toString("base64"),
            },
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
      providerId: "cloud",
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
    expect(runtime.plugins[0]?.views?.[0]).toMatchObject({
      id: "cloud-capability.view",
      bundleUrl:
        "/api/capability-router/assets/cloud-capability/cloud-capability-plugin/assets/cloud-capability.js",
    });
    await expect(
      runtime.actions[0]?.handler(runtime, {
        content: { text: "run" },
      } as never),
    ).resolves.toMatchObject({
      success: true,
      text: "cloud capability action",
    });
    await expect(
      runtime.providers[0]?.get(runtime, {} as never, {} as never),
    ).resolves.toMatchObject({
      text: "cloud capability provider",
      values: { source: "cloud" },
    });
    await expect(
      runtime.routes[0]?.routeHandler?.({
        runtime,
        method: "POST",
        path: "/cloud/capability",
        body: { id: "abc" },
        params: {},
        query: {},
        headers: {},
        inProcess: false,
      }),
    ).resolves.toEqual({
      status: 202,
      headers: { "x-cloud-capability": "yes" },
      body: { routed: true },
    });
    const router = runtime.getService(
      CAPABILITY_ROUTER_SERVICE_TYPE,
    ) as RemoteCapabilityRouterService | null;
    await expect(
      router?.plugin.getAsset({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        path: "/assets/cloud-capability.js",
      }),
    ).resolves.toMatchObject({
      contentType: "text/javascript",
      bodyBase64: expect.any(String),
    });
    const evaluatorTarget = {
      endpointId: "cloud-capability",
      moduleId: "cloud-capability-plugin",
      evaluator: "CLOUD_CAPABILITY_EVALUATOR",
      message: { text: "evaluate" },
      state: {},
      options: {},
    };
    await expect(
      router?.plugin.shouldRunEvaluator(evaluatorTarget),
    ).resolves.toEqual({ shouldRun: true });
    await expect(
      router?.plugin.prepareEvaluator(evaluatorTarget),
    ).resolves.toEqual({ prepared: { cloudPrepared: true } });
    await expect(
      router?.plugin.promptEvaluator({
        ...evaluatorTarget,
        prepared: { cloudPrepared: true },
      }),
    ).resolves.toEqual({ prompt: "cloud evaluator prompt" });
    await expect(
      router?.plugin.processEvaluator({
        ...evaluatorTarget,
        prepared: { cloudPrepared: true },
        output: { text: "done" },
      }),
    ).resolves.toEqual({ result: { cloudProcessed: true } });
    await expect(
      router?.plugin.shouldRunResponseHandlerEvaluator({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        evaluator: "CLOUD_CAPABILITY_RESPONSE_EVALUATOR",
        context: { cloud: true },
      }),
    ).resolves.toEqual({ shouldRun: true });
    await expect(
      router?.plugin.evaluateResponseHandlerEvaluator({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        evaluator: "CLOUD_CAPABILITY_RESPONSE_EVALUATOR",
        context: { cloud: true },
      }),
    ).resolves.toEqual({ patch: { cloudResponse: true } });
    await expect(
      router?.plugin.shouldRunResponseHandlerFieldEvaluator({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        field: "cloud_status",
        context: { cloud: true },
      }),
    ).resolves.toEqual({ shouldRun: true });
    await expect(
      router?.plugin.parseResponseHandlerFieldEvaluator({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        field: "cloud_status",
        context: { cloud: true },
        value: { raw: true },
      }),
    ).resolves.toEqual({ value: { cloudParsed: true } });
    await expect(
      router?.plugin.handleResponseHandlerFieldEvaluator({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        field: "cloud_status",
        context: { cloud: true },
        value: { raw: true },
        parsed: { cloudParsed: true },
      }),
    ).resolves.toEqual({ effect: { patch: { cloudHandled: true } } });
    await expect(
      router?.plugin.invokeModel({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        modelType: "CLOUD_TEXT",
        params: { prompt: "cloud model" },
      }),
    ).resolves.toEqual({ result: { cloudModel: true } });
    await expect(
      router?.plugin.callLifecycle({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        hook: "init",
        context: { cloud: true },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      router?.plugin.handleEvent({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        eventName: "cloud.capability.event",
        payload: { cloud: true },
      }),
    ).resolves.toEqual({ handled: true });
    await expect(
      router?.plugin.callService({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        serviceType: "cloud-capability-service",
        method: "ping",
        args: [{ cloud: true }],
      }),
    ).resolves.toEqual({ result: { cloudService: true } });
    await expect(
      router?.plugin.callAppBridge({
        endpointId: "cloud-capability",
        moduleId: "cloud-capability-plugin",
        hook: "prepareLaunch",
        context: { cloud: true },
      }),
    ).resolves.toEqual({
      result: { handled: true, body: { cloudBridge: true } },
    });
    const capabilityCalls = fetchMock.mock.calls.filter(
      ([url]) =>
        String(url) ===
        "https://capability-cloud.example.test/v1/capabilities/invoke",
    );
    expect(capabilityCalls).toHaveLength(19);
    expect(
      capabilityCalls.map(([, init]) => {
        const body = JSON.parse(String(init?.body)) as { method?: string };
        return body.method;
      }),
    ).toEqual([
      "plugin.modules.list",
      "plugin.action.invoke",
      "plugin.provider.get",
      "plugin.route.call",
      "plugin.asset.get",
      "plugin.evaluator.shouldRun",
      "plugin.evaluator.prepare",
      "plugin.evaluator.prompt",
      "plugin.evaluator.process",
      "plugin.responseHandlerEvaluator.shouldRun",
      "plugin.responseHandlerEvaluator.evaluate",
      "plugin.responseHandlerFieldEvaluator.shouldRun",
      "plugin.responseHandlerFieldEvaluator.parse",
      "plugin.responseHandlerFieldEvaluator.handle",
      "plugin.model.invoke",
      "plugin.lifecycle.call",
      "plugin.event.handle",
      "plugin.service.call",
      "plugin.appBridge.call",
    ]);
    for (const [, init] of capabilityCalls) {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer capability-token",
      });
    }
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
