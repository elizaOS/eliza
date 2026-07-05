/**
 * Unit coverage for the remote capability router client and fetch handler.
 * Drives config resolution, endpoint dedup/validation, and capability routing
 * with a stubbed `globalThis.fetch` (no real server): asserts the canonical
 * HTTP invoke shapes, remote error passthrough, per-endpoint routing,
 * multi-endpoint module aggregation, unsafe view-bundle rejection, and the
 * server-side fetch handler (auth, invoke round-trips, asset serving).
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { CapabilityError, UnavailableCapabilityRouter } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteCapabilityFetchHandler,
  RemoteCapabilityRouterService,
  resolveRemoteCapabilityRouterConfig,
} from "./remote-capability-router.ts";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Remote Capability Test" },
    getSetting: (key: string) => settings[key],
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

const originalFetch = globalThis.fetch;

describe("remote capability router", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves canonical env names", () => {
    const config = resolveRemoteCapabilityRouterConfig(
      makeRuntime({
        ELIZA_CAPABILITY_ROUTER_URL: "https://capability.example/",
        ELIZA_CAPABILITY_ROUTER_TOKEN: "cap-token",
        ELIZA_CAPABILITY_ROUTER_ENVIRONMENT: "mobile",
        ELIZA_CAPABILITY_ROUTER_TIMEOUT_MS: "1234",
      }),
    );

    expect(config).toMatchObject({
      enabled: true,
      baseUrl: "https://capability.example",
      token: "cap-token",
      environment: "mobile",
      requestTimeoutMs: 1234,
    });
  });

  it("resolves multiple canonical remote endpoint URLs", () => {
    const config = resolveRemoteCapabilityRouterConfig(
      makeRuntime({
        ELIZA_CAPABILITY_ROUTER_URLS:
          "https://device.example/, https://cloud.example/",
        ELIZA_CAPABILITY_ROUTER_TOKEN: "shared-token",
      }),
    );

    expect(config).toMatchObject({
      enabled: true,
      endpoints: [
        {
          id: "remote-1",
          baseUrl: "https://device.example",
          token: "shared-token",
        },
        {
          id: "remote-2",
          baseUrl: "https://cloud.example",
          token: "shared-token",
        },
      ],
    });
  });

  it("rejects ambiguous or malformed remote endpoint configuration", () => {
    expect(
      () =>
        new RemoteCapabilityRouterService(makeRuntime(), {
          enabled: true,
          endpoints: [
            { id: "device", baseUrl: "https://device.example" },
            { id: " device ", baseUrl: "https://other-device.example" },
          ],
          environment: "server",
          requestTimeoutMs: 1000,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_DECODE_FAILED",
        method: "capability-router.configure",
        message:
          'Remote capability endpoint id "device" is configured more than once.',
      }),
    );

    expect(
      () =>
        new RemoteCapabilityRouterService(makeRuntime(), {
          enabled: true,
          endpoints: [
            { id: "device", baseUrl: "https://device.example/" },
            { id: "cloud", baseUrl: "https://device.example" },
          ],
          environment: "server",
          requestTimeoutMs: 1000,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_DECODE_FAILED",
        method: "capability-router.configure",
        message:
          'Remote capability endpoint URL "https://device.example" is configured more than once.',
      }),
    );

    expect(
      () =>
        new RemoteCapabilityRouterService(makeRuntime(), {
          enabled: true,
          endpoints: [{ id: "device", baseUrl: "file:///tmp/capability" }],
          environment: "server",
          requestTimeoutMs: 1000,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_DECODE_FAILED",
        method: "capability-router.configure",
        message:
          "Remote capability endpoint baseUrl must be an absolute http(s) URL.",
      }),
    );
  });

  it("routes capability calls through the canonical HTTP invoke endpoint", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: request.method === "POST" ? await request.json() : undefined,
        });
        if (request.url.endsWith("/v1/capabilities")) {
          return jsonResponse({
            environment: "server",
            available: true,
            capabilities: {
              fs: true,
              pty: true,
              git: true,
              model: false,
              plugin: true,
            },
          });
        }
        return jsonResponse({
          ok: true,
          result: {
            path: "/workspace/README.md",
            text: "hello",
            size: 5,
            truncated: false,
          },
        });
      },
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      baseUrl: "https://capability.example",
      token: "token",
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.availability()).resolves.toMatchObject({
      available: true,
      capabilities: {
        fs: true,
        pty: true,
        git: true,
        model: false,
        plugin: true,
      },
    });
    await expect(
      service.fs.readText({ path: "/workspace/README.md" }),
    ).resolves.toEqual({
      path: "/workspace/README.md",
      text: "hello",
      size: 5,
      truncated: false,
    });

    expect(calls).toEqual([
      {
        url: "https://capability.example/v1/capabilities",
        authorization: "Bearer token",
        body: undefined,
      },
      {
        url: "https://capability.example/v1/capabilities/invoke",
        authorization: "Bearer token",
        body: {
          method: "fs.readText",
          params: { path: "/workspace/README.md" },
        },
      },
    ]);
  });

  it("preserves remote capability errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: false,
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "fs denied",
          capability: "fs",
          method: "fs.readText",
        },
      }),
    ) as unknown as typeof fetch;
    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      baseUrl: "https://capability.example",
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(
      service.fs.readText({ path: "/secret" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "fs",
      method: "fs.readText",
      message: "fs denied",
    });
  });

  it("exposes a fetch handler for remote capability servers", async () => {
    const handler = createRemoteCapabilityFetchHandler(
      new UnavailableCapabilityRouter("mobile", "not granted"),
    );

    const availability = await handler(
      new Request("https://device.test/v1/capabilities"),
    );
    await expect(availability.json()).resolves.toMatchObject({
      environment: "mobile",
      available: false,
    });

    const invoke = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "fs.readText",
          params: { path: "/tmp/a.txt" },
        }),
      }),
    );
    await expect(invoke.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        capability: "fs",
        method: "fs.readText",
      },
    });
  });

  it("can require bearer auth on capability fetch handlers", async () => {
    const handler = createRemoteCapabilityFetchHandler(
      new UnavailableCapabilityRouter("mobile", "not granted"),
      { token: "server-token" },
    );

    const unauthorized = await handler(
      new Request("https://device.test/v1/capabilities"),
    );
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        message: "Capability router request is not authorized.",
      },
    });

    const authorized = await handler(
      new Request("https://device.test/v1/capabilities", {
        headers: { authorization: "Bearer server-token" },
      }),
    );
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      environment: "mobile",
      available: false,
    });
  });

  it("round-trips remote plugin module methods through the fetch handler", async () => {
    const handler = createRemoteCapabilityFetchHandler({
      environment: "server",
      fs: new UnavailableCapabilityRouter("server").fs,
      pty: new UnavailableCapabilityRouter("server").pty,
      git: new UnavailableCapabilityRouter("server").git,
      model: new UnavailableCapabilityRouter("server").model,
      availability: async () => ({
        environment: "server",
        available: true,
        capabilities: {
          fs: false,
          pty: false,
          git: false,
          model: false,
          plugin: true,
        },
      }),
      plugin: {
        listModules: async () => ({
          modules: [
            {
              id: "remote-demo",
              name: "@remote/demo",
              config: {
                REMOTE_MODE: "demo",
                retryCount: 2,
                enabled: true,
                nullable: null,
              },
              schema: {
                remote_demo_records: {
                  id: "uuid",
                  message: "text",
                },
              },
              actions: [
                {
                  name: "REMOTE_DEMO",
                  description: "Run remote demo action.",
                },
              ],
              evaluators: [
                {
                  name: "REMOTE_EVALUATOR",
                  description: "Run remote evaluator.",
                  prompt: "Remote evaluator prompt.",
                  schema: { type: "object" },
                },
              ],
              responseHandlerEvaluators: [
                {
                  name: "REMOTE_RESPONSE_HANDLER",
                  description: "Run remote response handler.",
                  priority: 20,
                },
              ],
              responseHandlerFieldEvaluators: [
                {
                  name: "remoteHints",
                  description: "Remote field hints.",
                  priority: 30,
                  schema: { type: "array", items: { type: "string" } },
                  hasParse: true,
                  hasHandle: true,
                },
              ],
              lifecycle: { hooks: ["init", "dispose", "applyConfig"] },
              events: [{ eventName: "REMOTE_EVENT" }],
              models: [{ modelType: "REMOTE_TEXT", priority: 25 }],
              services: [
                {
                  serviceType: "remote_demo_service",
                  capabilityDescription: "Remote demo service.",
                  methods: ["lookup"],
                  config: { region: "remote" },
                },
              ],
              routes: [{ method: "POST", path: "/demo" }],
              views: [
                {
                  id: "demo",
                  label: "Demo",
                  bundlePath: "/assets/demo.js",
                },
              ],
            },
          ],
        }),
        invokeAction: async () => ({ text: "remote action ran" }),
        getProvider: async () => ({ text: "remote provider" }),
        callRoute: async () => ({ status: 200, body: { ok: true } }),
        getAsset: async () => ({
          path: "/assets/demo.js",
          contentType: "text/javascript",
          bodyBase64: Buffer.from("export default {}").toString("base64"),
        }),
        shouldRunEvaluator: async () => ({ shouldRun: true }),
        prepareEvaluator: async () => ({ prepared: { ok: true } }),
        promptEvaluator: async () => ({ prompt: "remote evaluator prompt" }),
        processEvaluator: async () => ({
          result: { success: true, text: "remote evaluator processed" },
        }),
        shouldRunResponseHandlerEvaluator: async () => ({ shouldRun: true }),
        evaluateResponseHandlerEvaluator: async () => ({
          patch: { reply: "remote response handler" },
        }),
        shouldRunResponseHandlerFieldEvaluator: async () => ({
          shouldRun: true,
        }),
        parseResponseHandlerFieldEvaluator: async () => ({
          value: ["REMOTE_HINT"],
        }),
        handleResponseHandlerFieldEvaluator: async () => ({
          effect: {
            patch: { candidateActionNames: ["REMOTE_DEMO"] },
            debug: ["remote field handled"],
          },
        }),
        callLifecycle: async () => ({ ok: true }),
        handleEvent: async () => ({ handled: true }),
        invokeModel: async () => ({ result: "remote model text" }),
        callService: async () => ({
          result: { ok: true, service: "remote-demo" },
        }),
        callAppBridge: async () => ({
          result: { launchUrl: "https://device.test/prepared" },
        }),
      },
    });

    const modules = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({ method: "plugin.modules.list", params: {} }),
      }),
    );
    await expect(modules.json()).resolves.toMatchObject({
      ok: true,
      result: {
        modules: [
          {
            id: "remote-demo",
            config: {
              REMOTE_MODE: "demo",
              retryCount: 2,
              enabled: true,
              nullable: null,
            },
            schema: {
              remote_demo_records: {
                id: "uuid",
                message: "text",
              },
            },
            actions: [{ name: "REMOTE_DEMO" }],
            evaluators: [{ name: "REMOTE_EVALUATOR" }],
            responseHandlerEvaluators: [{ name: "REMOTE_RESPONSE_HANDLER" }],
            responseHandlerFieldEvaluators: [{ name: "remoteHints" }],
            lifecycle: { hooks: ["init", "dispose", "applyConfig"] },
            events: [{ eventName: "REMOTE_EVENT" }],
            models: [{ modelType: "REMOTE_TEXT", priority: 25 }],
            services: [{ serviceType: "remote_demo_service" }],
            routes: [{ method: "POST", path: "/demo" }],
            views: [{ id: "demo", bundlePath: "/assets/demo.js" }],
          },
        ],
      },
    });

    const action = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.action.invoke",
          params: { moduleId: "remote-demo", action: "REMOTE_DEMO" },
        }),
      }),
    );
    await expect(action.json()).resolves.toMatchObject({
      ok: true,
      result: { text: "remote action ran" },
    });

    const evaluator = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.evaluator.prompt",
          params: {
            moduleId: "remote-demo",
            evaluator: "REMOTE_EVALUATOR",
            prepared: { ok: true },
          },
        }),
      }),
    );
    await expect(evaluator.json()).resolves.toMatchObject({
      ok: true,
      result: { prompt: "remote evaluator prompt" },
    });

    const responseHandlerEvaluator = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.responseHandlerEvaluator.evaluate",
          params: {
            moduleId: "remote-demo",
            evaluator: "REMOTE_RESPONSE_HANDLER",
            context: { messageHandler: { processMessage: "RESPOND" } },
          },
        }),
      }),
    );
    await expect(responseHandlerEvaluator.json()).resolves.toMatchObject({
      ok: true,
      result: { patch: { reply: "remote response handler" } },
    });

    const responseHandlerField = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.responseHandlerFieldEvaluator.handle",
          params: {
            moduleId: "remote-demo",
            field: "remoteHints",
            value: ["REMOTE_HINT"],
            parsed: { remoteHints: ["REMOTE_HINT"] },
          },
        }),
      }),
    );
    await expect(responseHandlerField.json()).resolves.toMatchObject({
      ok: true,
      result: {
        effect: {
          patch: { candidateActionNames: ["REMOTE_DEMO"] },
          debug: ["remote field handled"],
        },
      },
    });

    const lifecycle = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.lifecycle.call",
          params: {
            moduleId: "remote-demo",
            hook: "init",
            config: { mode: "test" },
          },
        }),
      }),
    );
    await expect(lifecycle.json()).resolves.toMatchObject({
      ok: true,
      result: { ok: true },
    });

    const event = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.event.handle",
          params: {
            moduleId: "remote-demo",
            eventName: "REMOTE_EVENT",
            payload: { message: "event payload" },
          },
        }),
      }),
    );
    await expect(event.json()).resolves.toMatchObject({
      ok: true,
      result: { handled: true },
    });

    const model = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.model.invoke",
          params: {
            moduleId: "remote-demo",
            modelType: "REMOTE_TEXT",
            params: { prompt: "hello" },
          },
        }),
      }),
    );
    await expect(model.json()).resolves.toMatchObject({
      ok: true,
      result: { result: "remote model text" },
    });

    const service = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.service.call",
          params: {
            moduleId: "remote-demo",
            serviceType: "remote_demo_service",
            method: "lookup",
            args: [{ query: "demo" }],
          },
        }),
      }),
    );
    await expect(service.json()).resolves.toMatchObject({
      ok: true,
      result: { result: { ok: true, service: "remote-demo" } },
    });

    const appBridge = await handler(
      new Request("https://device.test/v1/capabilities/invoke", {
        method: "POST",
        body: JSON.stringify({
          method: "plugin.appBridge.call",
          params: {
            moduleId: "remote-demo",
            hook: "prepareLaunch",
            context: { appName: "@remote/demo" },
          },
        }),
      }),
    );
    await expect(appBridge.json()).resolves.toMatchObject({
      ok: true,
      result: { result: { launchUrl: "https://device.test/prepared" } },
    });
  });

  it("aggregates plugin modules from multiple remote capability endpoints", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });
        if (request.url.startsWith("https://device.example")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "device-plugin",
                  name: "@remote/device",
                  views: [
                    {
                      id: "device-view",
                      label: "Device View",
                      bundlePath: "/assets/device-view.js",
                      framePath: "/assets/device-frame.html",
                    },
                  ],
                  actions: [
                    {
                      name: "DEVICE_ACTION",
                      description: "Device action.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (
          request.url.startsWith("https://cloud.example") &&
          isInvokeBody(body, "plugin.modules.list")
        ) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "cloud-plugin",
                  name: "@remote/cloud",
                  actions: [
                    {
                      name: "CLOUD_ACTION",
                      description: "Cloud action.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (
          request.url.startsWith("https://cloud.example") &&
          isInvokeBody(body, "plugin.action.invoke")
        ) {
          return jsonResponse({
            ok: true,
            result: { text: "cloud action ran" },
          });
        }
        return jsonResponse({ ok: false, error: { message: "unexpected" } });
      },
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [
        { id: "device", baseUrl: "https://device.example" },
        { id: "cloud", baseUrl: "https://cloud.example" },
      ],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).resolves.toMatchObject({
      modules: [
        {
          id: "device-plugin",
          name: "@remote/device",
          views: [
            {
              id: "device-view",
              bundleUrl:
                "https://device.example/v1/capabilities/assets/device-plugin/assets/device-view.js",
              frameUrl:
                "https://device.example/v1/capabilities/assets/device-plugin/assets/device-frame.html",
            },
          ],
        },
        { id: "cloud-plugin", name: "@remote/cloud" },
      ],
    });
    await expect(
      service.plugin.invokeAction({
        moduleId: "cloud-plugin",
        action: "CLOUD_ACTION",
      }),
    ).resolves.toEqual({ text: "cloud action ran" });

    expect(calls).toMatchObject([
      { url: "https://device.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
    ]);
  });

  it("rejects unsafe remote view bundle paths before exposing browser import URLs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "device-plugin",
              name: "@remote/device",
              views: [
                {
                  id: "device-view",
                  label: "Device View",
                  bundlePath: "../secrets.js",
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin asset path "../secrets.js" must not contain empty, current-directory, or parent-directory segments.',
    });
  });

  it("rewrites remote sandboxed iframe frame paths into proxied frame URLs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "device-plugin",
              name: "@remote/device",
              views: [
                {
                  id: "device-frame-view",
                  label: "Device Frame View",
                  framePath: "dist/views/frame.html",
                  surface: { isolation: "sandboxed-iframe" },
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).resolves.toMatchObject({
      modules: [
        {
          id: "device-plugin",
          views: [
            {
              id: "device-frame-view",
              frameUrl:
                "https://device.example/v1/capabilities/assets/device-plugin/dist/views/frame.html",
            },
          ],
        },
      ],
    });
  });

  it("rejects unsafe remote view frame URLs before exposing browser frame URLs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "device-plugin",
              name: "@remote/device",
              views: [
                {
                  id: "device-view",
                  label: "Device View",
                  frameUrl: "javascript:alert(1)",
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin frameUrl "javascript:alert(1)" must be an absolute http(s) URL without embedded credentials.',
    });
  });

  it("rejects unsafe remote view bundle URLs before exposing browser import URLs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "device-plugin",
              name: "@remote/device",
              views: [
                {
                  id: "device-view",
                  label: "Device View",
                  bundleUrl: "javascript:alert(1)",
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin bundleUrl "javascript:alert(1)" must be an absolute http(s) URL without embedded credentials.',
    });
  });

  it("rejects unsafe sandboxed remote view frame URLs before exposing browser frame URLs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "device-plugin",
              name: "@remote/device",
              views: [
                {
                  id: "device-frame-view",
                  label: "Device Frame View",
                  frameUrl: "javascript:alert(1)",
                  surface: { isolation: "sandboxed-iframe" },
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin frameUrl "javascript:alert(1)" must be an absolute http(s) URL without embedded credentials.',
    });
  });

  it("routes low-level capabilities to explicit endpoint ids", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });
        if (!isRecord(body) || typeof body.method !== "string") {
          return jsonResponse({ ok: false, error: { message: "unexpected" } });
        }
        if (body.method === "fs.readText") {
          return jsonResponse({
            ok: true,
            result: {
              path: "/device/file.txt",
              text: "device text",
              size: 11,
              truncated: false,
            },
          });
        }
        if (body.method === "pty.command.run") {
          return jsonResponse({
            ok: true,
            result: {
              output: "cloud shell",
              exitCode: 0,
              timedOut: false,
            },
          });
        }
        if (body.method === "git.status") {
          return jsonResponse({
            ok: true,
            result: {
              repo: { root: "/repo" },
              files: [],
              raw: "clean",
            },
          });
        }
        if (body.method === "model.status") {
          return jsonResponse({
            ok: true,
            result: { ok: true, provider: "cloud-model" },
          });
        }
        return jsonResponse({ ok: false, error: { message: "unexpected" } });
      },
    ) as unknown as typeof fetch;

    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [
        { id: "device", baseUrl: "https://device.example" },
        { id: "cloud", baseUrl: "https://cloud.example" },
      ],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(
      service.fs.readText({
        endpointId: "device",
        path: "/device/file.txt",
      }),
    ).resolves.toMatchObject({ text: "device text" });
    await expect(
      service.pty.runCommand({
        endpointId: "cloud",
        command: "echo",
        args: ["ok"],
      }),
    ).resolves.toMatchObject({ output: "cloud shell" });
    await expect(
      service.git.status({
        endpointId: "device",
        root: "/repo",
      }),
    ).resolves.toMatchObject({ raw: "clean" });
    await expect(
      service.model.status({ endpointId: "cloud" }),
    ).resolves.toMatchObject({ ok: true, provider: "cloud-model" });
    await expect(
      service.fs.list({ endpointId: "missing", path: "/" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      method: "fs.list",
    });

    expect(calls).toMatchObject([
      { url: "https://device.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
      { url: "https://device.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
    ]);
    expect(calls.map((call) => call.body)).toMatchObject([
      { method: "fs.readText", params: { endpointId: "device" } },
      { method: "pty.command.run", params: { endpointId: "cloud" } },
      { method: "git.status", params: { endpointId: "device" } },
      { method: "model.status", params: { endpointId: "cloud" } },
    ]);
  });

  it("rejects duplicate remote plugin module ids across endpoints", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "duplicate-plugin",
              name: "@remote/duplicate",
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [
        { id: "device", baseUrl: "https://device.example" },
        { id: "cloud", baseUrl: "https://cloud.example" },
      ],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
    });
  });

  it("rejects ambiguous remote plugin module ids before routing", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          modules: [
            {
              id: "bad:plugin",
              name: "@remote/bad",
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const service = new RemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      endpoints: [{ id: "device", baseUrl: "https://device.example" }],
      environment: "server",
      requestTimeoutMs: 1000,
    });

    await expect(service.plugin.listModules()).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        "Remote endpoint device returned a plugin module with invalid id.",
    });
  });

  it("throws a structured startup error when disabled", async () => {
    await expect(
      RemoteCapabilityRouterService.start(makeRuntime()),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isInvokeBody(body: unknown, method: string): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    (body as { method?: unknown }).method === method
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
