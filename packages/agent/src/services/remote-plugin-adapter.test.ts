import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  type Plugin,
  type PluginCallAppBridgeResult,
  type RemotePluginModuleManifest,
  type UUID,
} from "@elizaos/core";
import { build as esbuild } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistConfigEnv } from "../api/config-env.ts";
import { dispatchRoute } from "../api/dispatch-route.ts";
import {
  getView,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { loadElizaConfig } from "../config/config.ts";
import { importAppRouteModule } from "./app-package-modules.ts";
import {
  createRemoteCapabilityFetchHandler,
  RemoteCapabilityRouterService,
} from "./remote-capability-router.ts";
import {
  bootstrapRemoteCapabilityPlugins,
  createRemoteCapabilityPlugin,
  registerRemoteCapabilityPlugins,
  syncRemoteCapabilityPlugins,
} from "./remote-plugin-adapter.ts";

const remoteModule: RemotePluginModuleManifest = {
  id: "remote-demo",
  name: "@remote/demo",
  version: "1.2.3",
  description: "Remote demo plugin.",
  actions: [
    {
      name: "REMOTE_DEMO",
      description: "Run a remote action.",
      descriptionCompressed: "Remote action.",
      similes: ["DEMO_REMOTE"],
    },
  ],
  providers: [
    {
      name: "REMOTE_CONTEXT",
      description: "Remote context provider.",
      dynamic: true,
      private: true,
    },
  ],
  evaluators: [
    {
      name: "REMOTE_EVALUATOR",
      description: "Evaluate a remote post-turn condition.",
      prompt: "Remote evaluator prompt section.",
      similes: ["REMOTE_EVAL"],
      priority: 50,
      providers: ["REMOTE_CONTEXT"],
      schema: {
        type: "object",
        properties: {
          shouldRecord: { type: "boolean" },
        },
      },
      hasPrepare: true,
      hasProcessor: true,
    },
  ],
  events: [{ eventName: "REMOTE_EVENT" }],
  models: [{ modelType: "REMOTE_TEXT", priority: 75 }],
  widgets: [
    {
      id: "remote.widget",
      slot: "chat-sidebar",
      label: "Remote Widget",
      icon: "PanelRight",
      order: 40,
      defaultEnabled: true,
    },
  ],
  app: {
    displayName: "Remote Demo App",
    category: "tool",
    launchType: "url",
    launchUrl: "https://remote.example/app",
    icon: "PanelRight",
    capabilities: ["remote-demo"],
    viewer: {
      url: "https://remote.example/viewer",
      embedParams: { mode: "demo" },
      postMessageAuth: true,
    },
    session: {
      mode: "viewer",
      features: ["commands"],
    },
    navTabs: [
      {
        id: "remote.demo",
        label: "Remote Demo",
        path: "/remote-demo",
        icon: "PanelRight",
        order: 25,
      },
    ],
  },
  appBridge: {
    hooks: [
      "prepareLaunch",
      "resolveViewerAuthMessage",
      "collectLaunchDiagnostics",
      "resolveLaunchSession",
      "refreshRunSession",
      "stopRun",
      "handleAppRoutes",
    ],
  },
  routes: [
    {
      method: "POST",
      path: "/remote/demo",
      public: true,
      name: "remote-demo",
      description: "Remote route.",
    },
  ],
  views: [
    {
      id: "remote-view",
      label: "Remote View",
      viewType: "gui",
      bundleUrl: "https://remote.example/assets/remote-view.js",
    },
  ],
};

const originalFetch = globalThis.fetch;
type CapabilityServerChild = ChildProcessByStdio<null, Readable, Readable>;
const dockerSmoke =
  process.env.ELIZA_REMOTE_CAPABILITY_DOCKER_SMOKE === "1" ? it : it.skip;
const registeredViewPlugins = [
  "@remote/device-tools",
  "@remote/cloud-tools",
  "@remote/localhost-tools",
  "@remote/built-source",
  "@remote/process-plugin",
  "@remote/docker-plugin",
];

describe("remote plugin adapter", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const pluginName of registeredViewPlugins) {
      unregisterPluginViews(pluginName);
    }
  });

  it("materializes remote manifests as normal plugin contributions", async () => {
    const calls: unknown[] = [];
    const router = makeRouter({
      invokeAction: async (params) => {
        calls.push({ method: "action", params });
        return {
          text: "remote action ran",
          actions: ["NEXT_ACTION"],
          values: { ok: true },
          data: { id: "result-1" },
        };
      },
      getProvider: async (params) => {
        calls.push({ method: "provider", params });
        return {
          text: "remote provider context",
          values: { mood: "focused" },
          data: { source: "remote" },
        };
      },
      callRoute: async (params) => {
        calls.push({ method: "route", params });
        return {
          status: 202,
          headers: { "x-remote": "yes" },
          body: { accepted: true },
        };
      },
      shouldRunEvaluator: async (params) => {
        calls.push({ method: "evaluator.shouldRun", params });
        return { shouldRun: true };
      },
      prepareEvaluator: async (params) => {
        calls.push({ method: "evaluator.prepare", params });
        return { prepared: { fromPrepare: true } };
      },
      promptEvaluator: async () => ({ prompt: "unused remote prompt" }),
      processEvaluator: async (params) => {
        calls.push({ method: "evaluator.process", params });
        return {
          result: {
            success: true,
            text: "remote evaluator processed",
          },
        };
      },
      handleEvent: async (params) => {
        calls.push({ method: "event", params });
        return { handled: true };
      },
      invokeModel: async (params) => {
        calls.push({ method: "model", params });
        return { result: "remote model result" };
      },
      callAppBridge: async (params): Promise<PluginCallAppBridgeResult> => {
        calls.push({ method: "appBridge", params });
        if (params.hook === "prepareLaunch") {
          return { result: { launchUrl: "https://remote.example/prepared" } };
        }
        if (params.hook === "resolveViewerAuthMessage") {
          return { result: { type: "REMOTE_AUTH", agentId: "agent-1" } };
        }
        if (params.hook === "collectLaunchDiagnostics") {
          return {
            result: [
              {
                code: "remote-ok",
                severity: "info",
                message: "Remote bridge ok.",
              },
            ],
          };
        }
        if (
          params.hook === "resolveLaunchSession" ||
          params.hook === "refreshRunSession"
        ) {
          return {
            result: {
              sessionId: "remote-session",
              appName: "@remote/demo",
              mode: "viewer",
              status: "ready",
            },
          };
        }
        if (params.hook === "handleAppRoutes") {
          return {
            result: {
              handled: true,
              status: 201,
              headers: { "x-remote-app-route": "yes" },
              body: {
                ok: true,
                method:
                  params.context && "method" in params.context
                    ? params.context.method
                    : null,
                body:
                  params.context && "body" in params.context
                    ? params.context.body
                    : null,
              },
            },
          };
        }
        return {};
      },
    });
    const runtime = makeRuntime(router);
    const plugin = createRemoteCapabilityPlugin(remoteModule);

    expect(plugin).toMatchObject({
      name: "@remote/demo",
      description: "Remote demo plugin.",
      config: {
        remoteCapabilityModuleId: "remote-demo",
        remoteCapabilityVersion: "1.2.3",
      },
    });
    expect(plugin.views?.[0]).toMatchObject({
      id: "remote-view",
      bundleUrl: "https://remote.example/assets/remote-view.js",
    });
    expect(plugin.widgets?.[0]).toMatchObject({
      id: "remote.widget",
      pluginId: "@remote/demo",
      slot: "chat-sidebar",
      label: "Remote Widget",
      order: 40,
    });
    expect(plugin.app).toMatchObject({
      displayName: "Remote Demo App",
      category: "tool",
      viewer: {
        url: "https://remote.example/viewer",
        embedParams: { mode: "demo" },
      },
      session: {
        mode: "viewer",
        features: ["commands"],
      },
      navTabs: [{ id: "remote.demo", path: "/remote-demo" }],
    });
    await plugin.init?.({}, runtime);
    const routeModule = await importAppRouteModule("@remote/demo");
    await expect(
      routeModule?.prepareLaunch?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
      }),
    ).resolves.toEqual({ launchUrl: "https://remote.example/prepared" });
    await expect(
      routeModule?.resolveViewerAuthMessage?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
      }),
    ).resolves.toEqual({ type: "REMOTE_AUTH", agentId: "agent-1" });
    await expect(
      routeModule?.collectLaunchDiagnostics?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
        runId: "run-1",
        session: null,
      }),
    ).resolves.toEqual([
      { code: "remote-ok", severity: "info", message: "Remote bridge ok." },
    ]);
    await expect(
      routeModule?.resolveLaunchSession?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
      }),
    ).resolves.toMatchObject({ sessionId: "remote-session" });
    await expect(
      routeModule?.refreshRunSession?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
        runId: "run-1",
        session: null,
      }),
    ).resolves.toMatchObject({ sessionId: "remote-session" });
    await expect(
      routeModule?.stopRun?.({
        appName: "@remote/demo",
        launchUrl: "https://remote.example/app",
        runtime,
        viewer: null,
        runId: "run-1",
        session: null,
      }),
    ).resolves.toBeUndefined();
    const routeResponse = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      ended: "",
      setHeader(key: string, value: string) {
        this.headers[key] = value;
      },
      end(value?: string) {
        this.ended = value ?? "";
      },
    };
    await expect(
      routeModule?.handleAppRoutes?.({
        req: {
          headers: { authorization: "Bearer local" },
        },
        res: routeResponse,
        method: "POST",
        pathname: "/api/apps/remote-demo/command",
        url: new URL(
          "http://localhost/api/apps/remote-demo/command?runId=run-1",
        ),
        runtime,
        readJsonBody: async () => ({ command: "ping" }),
        json: (res: typeof routeResponse, data: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(data));
        },
        error: () => {},
      } as never),
    ).resolves.toBe(true);
    expect(routeResponse.statusCode).toBe(201);
    expect(routeResponse.headers).toMatchObject({
      "x-remote-app-route": "yes",
      "content-type": "application/json",
    });
    expect(JSON.parse(routeResponse.ended)).toEqual({
      ok: true,
      method: "POST",
      body: { command: "ping" },
    });
    await plugin.dispose?.(runtime);

    const callback = vi.fn();
    await expect(
      plugin.actions?.[0]?.handler(
        runtime,
        { content: { prompt: "run it" } } as never,
        undefined,
        { dryRun: false },
        callback,
      ),
    ).resolves.toMatchObject({
      success: true,
      text: "remote action ran",
      values: { ok: true },
      data: { id: "result-1" },
    });
    expect(callback).toHaveBeenCalledWith(
      { text: "remote action ran", actions: ["NEXT_ACTION"] },
      "REMOTE_DEMO",
    );

    await expect(
      plugin.providers?.[0]?.get(
        runtime,
        {} as never,
        {
          values: { topic: "demo" },
        } as never,
      ),
    ).resolves.toMatchObject({
      text: "remote provider context",
      values: { mood: "focused" },
      data: { source: "remote" },
    });

    await expect(
      plugin.routes?.[0]?.routeHandler?.({
        runtime,
        method: "POST",
        path: "/remote/demo",
        body: { input: "value" },
        params: {},
        query: { q: "1" },
        headers: { accept: "application/json" },
        inProcess: false,
      }),
    ).resolves.toEqual({
      status: 202,
      headers: { "x-remote": "yes" },
      body: { accepted: true },
    });
    expect(plugin.routes?.[0]).toMatchObject({
      path: "/remote/demo",
      rawPath: true,
    });
    expect(plugin.evaluators?.[0]).toMatchObject({
      name: "REMOTE_EVALUATOR",
      description: "Evaluate a remote post-turn condition.",
      providers: ["REMOTE_CONTEXT"],
      priority: 50,
    });

    const evaluatorContext = {
      runtime,
      message: {
        id: "22222222-2222-2222-2222-222222222222" as UUID,
        entityId: "33333333-3333-3333-3333-333333333333" as UUID,
        roomId: "44444444-4444-4444-4444-444444444444" as UUID,
        content: { text: "remember this" },
      },
      state: { values: { existing: true }, data: {}, text: "state text" },
      options: { didRespond: true },
    };
    await expect(
      plugin.evaluators?.[0]?.shouldRun(evaluatorContext),
    ).resolves.toBe(true);
    await expect(
      plugin.evaluators?.[0]?.prepare?.(evaluatorContext),
    ).resolves.toEqual({ fromPrepare: true });
    expect(
      plugin.evaluators?.[0]?.prompt({
        ...evaluatorContext,
        prepared: { fromPrepare: true },
      } as never),
    ).toBe("Remote evaluator prompt section.");
    await expect(
      plugin.evaluators?.[0]?.processors?.[0]?.process({
        ...evaluatorContext,
        prepared: { fromPrepare: true },
        output: { shouldRecord: true },
        evaluatorName: "REMOTE_EVALUATOR",
      } as never),
    ).resolves.toMatchObject({
      success: true,
      text: "remote evaluator processed",
    });
    await expect(
      (
        plugin.events as Record<
          string,
          Array<(payload: unknown) => Promise<void> | void>
        >
      )?.["REMOTE_EVENT"]?.[0]?.({
        runtime,
        message: "event payload",
      } as never),
    ).resolves.toBeUndefined();
    await expect(
      (
        plugin.models as Record<
          string,
          (
            runtime: IAgentRuntime,
            params: Record<string, unknown>,
          ) => Promise<unknown>
        >
      )?.REMOTE_TEXT?.(runtime, { prompt: "model prompt" }),
    ).resolves.toBe("remote model result");
    expect(plugin.priority).toBe(75);

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: "action",
          params: {
            moduleId: "remote-demo",
            action: "REMOTE_DEMO",
            content: { prompt: "run it" },
            options: { dryRun: false },
          },
        },
        {
          method: "provider",
          params: {
            moduleId: "remote-demo",
            provider: "REMOTE_CONTEXT",
            state: { values: { topic: "demo" } },
          },
        },
        {
          method: "route",
          params: {
            moduleId: "remote-demo",
            method: "POST",
            path: "/remote/demo",
            body: { input: "value" },
            query: { q: "1" },
            headers: { accept: "application/json" },
          },
        },
        {
          method: "evaluator.shouldRun",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            evaluator: "REMOTE_EVALUATOR",
            message: {
              id: "22222222-2222-2222-2222-222222222222",
              entityId: "33333333-3333-3333-3333-333333333333",
              roomId: "44444444-4444-4444-4444-444444444444",
              content: { text: "remember this" },
            },
            state: { values: { existing: true }, data: {}, text: "state text" },
            options: { didRespond: true },
          }),
        },
        {
          method: "evaluator.prepare",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            evaluator: "REMOTE_EVALUATOR",
          }),
        },
        {
          method: "evaluator.process",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            evaluator: "REMOTE_EVALUATOR",
            prepared: { fromPrepare: true },
            output: { shouldRecord: true },
          }),
        },
        {
          method: "event",
          params: {
            moduleId: "remote-demo",
            eventName: "REMOTE_EVENT",
            payload: { message: "event payload" },
          },
        },
        {
          method: "model",
          params: {
            moduleId: "remote-demo",
            modelType: "REMOTE_TEXT",
            params: { prompt: "model prompt" },
          },
        },
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "prepareLaunch" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "resolveViewerAuthMessage" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "collectLaunchDiagnostics" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "resolveLaunchSession" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "refreshRunSession" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({ hook: "stopRun" }),
        }),
        expect.objectContaining({
          method: "appBridge",
          params: expect.objectContaining({
            hook: "handleAppRoutes",
            context: expect.objectContaining({
              method: "POST",
              pathname: "/api/apps/remote-demo/command",
              query: { runId: "run-1" },
              body: { command: "ping" },
            }),
          }),
        }),
      ]),
    );
  });

  it("registers remote modules through runtime.registerPlugin", async () => {
    const registered: Plugin[] = [];
    const router = makeRouter({
      listModules: async () => ({ modules: [remoteModule] }),
    });
    const runtime = makeRuntime(router, {
      registerPlugin: async (plugin) => {
        registered.push(plugin);
      },
    });

    await expect(registerRemoteCapabilityPlugins(runtime)).resolves.toEqual(
      registered,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("@remote/demo");
  });

  it("skips already registered plugins unless reload is requested", async () => {
    const registered: Plugin[] = [];
    const reloaded: Plugin[] = [];
    const runtime = makeRuntime(makeRouter(), {
      plugins: [createRemoteCapabilityPlugin(remoteModule)],
      registerPlugin: async (plugin) => {
        registered.push(plugin);
      },
      reloadPlugin: async (plugin) => {
        reloaded.push(plugin);
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, { modules: [remoteModule] }),
    ).resolves.toMatchObject({
      registered: [],
      skipped: ["@remote/demo"],
    });
    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [remoteModule],
        reloadExisting: true,
      }),
    ).resolves.toMatchObject({
      registered: [{ name: "@remote/demo" }],
      skipped: [],
    });
    expect(registered).toHaveLength(0);
    expect(reloaded).toHaveLength(1);
  });

  it("rejects duplicate remote plugin names in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-demo-copy",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin name collision for "@remote/demo" between modules "remote-demo" and "remote-demo-copy".',
    });
  });

  it("rejects remote plugin names that collide with local plugins", async () => {
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        {
          name: "@remote/demo",
          description: "Local plugin with the same name",
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, { modules: [remoteModule] }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" would collide with local plugin "@remote/demo".',
    });
  });

  it("rejects duplicate remote action and provider names in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-action-copy",
            name: "@remote/action-copy",
            routes: [],
            providers: [],
            evaluators: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote action name collision for "REMOTE_DEMO" between modules "remote-demo" and "remote-action-copy".',
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-provider-copy",
            name: "@remote/provider-copy",
            actions: [],
            routes: [],
            evaluators: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote provider name collision for "REMOTE_CONTEXT" between modules "remote-demo" and "remote-provider-copy".',
    });
  });

  it("rejects remote actions and providers that collide with local runtime components", async () => {
    const runtime = makeRuntime(makeRouter(), {
      actions: [
        {
          name: "REMOTE_DEMO",
          description: "Local action",
          validate: async () => true,
          handler: async () => ({ success: true }),
        },
      ],
      providers: [
        {
          name: "REMOTE_CONTEXT",
          get: async () => ({ text: "local provider" }),
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            providers: [],
            routes: [],
            evaluators: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" action "REMOTE_DEMO" would collide with an existing runtime action.',
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            routes: [],
            evaluators: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" provider "REMOTE_CONTEXT" would collide with an existing runtime provider.',
    });
  });

  it("rejects duplicate remote route method/path pairs in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-route-copy",
            name: "@remote/route-copy",
            actions: [],
            providers: [],
            evaluators: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote route collision for "POST /remote/demo" between modules "remote-demo" and "remote-route-copy".',
    });
  });

  it("rejects remote routes that collide with local runtime routes", async () => {
    const runtime = makeRuntime(makeRouter(), {
      routes: [
        {
          type: "POST",
          path: "/remote/demo",
          routeHandler: async () => ({ status: 200 }),
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, { modules: [remoteModule] }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" route "POST /remote/demo" would collide with an existing runtime route.',
    });
  });

  it("unloads remote plugins missing from the next manifest", async () => {
    const unloaded: string[] = [];
    const remotePlugin = createRemoteCapabilityPlugin(remoteModule);
    const remoteOwnership = {
      pluginName: "@remote/demo",
      plugin: remotePlugin,
      registeredPlugin: remotePlugin,
      actions: [],
      providers: [],
      evaluators: [],
      routes: [],
      events: [],
      models: [],
      services: [],
      sendHandlerSources: [],
      hasAdapter: false,
      registeredAt: Date.now(),
    };
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        remotePlugin,
        {
          name: "local-plugin",
          description: "Local plugin",
        },
      ],
      getAllPluginOwnership: () => [remoteOwnership],
      unloadPlugin: async (pluginName) => {
        unloaded.push(pluginName);
        return remoteOwnership;
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [],
        unloadMissing: true,
      }),
    ).resolves.toEqual({
      registered: [],
      unloaded: ["@remote/demo"],
      skipped: [],
    });
    expect(unloaded).toEqual(["@remote/demo"]);
  });

  it("bootstraps to no-op when the remote router is not configured", async () => {
    const runtime = makeRuntime(null, {
      getSetting: (key) =>
        key === "ELIZA_CAPABILITY_ROUTER_ENABLED" ? "false" : null,
    });

    await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
      registered: [],
      unloaded: [],
      skipped: [],
    });
  });

  it("bootstraps a router service when only endpoint URLs are configured", async () => {
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === "POST" ? await request.json() : undefined;
        if (isInvokeBody(body, "plugin.modules.list")) {
          return jsonResponse({
            ok: true,
            result: { modules: [remoteModule] },
          });
        }
        return jsonResponse({
          ok: false,
          error: { message: `unexpected request ${request.url}` },
        });
      },
    ) as unknown as typeof fetch;

    const services = new Map<string, RemoteCapabilityRouterService>();
    const runtime = makeRuntime(null, {
      plugins: [],
      actions: [],
      providers: [],
      evaluators: [],
      routes: [],
      getSetting: (key) =>
        key === "ELIZA_CAPABILITY_ROUTER_URLS"
          ? "https://device.example"
          : null,
      getService: (<T>(serviceType: string): T | null =>
        (services.get(serviceType) as T | undefined) ??
        null) as IAgentRuntime["getService"],
      hasService: (serviceType) => services.has(serviceType),
      registerService: async (ServiceClass) => {
        const service = new (
          ServiceClass as typeof RemoteCapabilityRouterService
        )(runtime);
        services.set(ServiceClass.serviceType, service);
      },
      getServiceLoadPromise: async (serviceType) => {
        const service = services.get(serviceType);
        if (!service) throw new Error("service not registered");
        return service as never;
      },
      registerPlugin: async (plugin: Plugin) => {
        runtime.plugins.push(plugin);
        runtime.actions.push(...(plugin.actions ?? []));
        runtime.providers.push(...(plugin.providers ?? []));
        runtime.evaluators.push(...(plugin.evaluators ?? []));
        runtime.routes.push(...(plugin.routes ?? []));
      },
    });

    await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
      registered: [expect.objectContaining({ name: "@remote/demo" })],
      unloaded: [],
      skipped: [],
    });
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/demo",
    ]);
  });

  it("bootstraps from persisted config.env endpoint JSON after restart", async () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
    const previousUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;
    const stateDir = await mkdtemp(
      join(tmpdir(), "remote-capability-restart-"),
    );
    const httpCalls: Array<{ url: string; authorization: string | null }> = [];

    try {
      process.env.ELIZA_STATE_DIR = stateDir;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;

      await persistConfigEnv("ELIZA_CAPABILITY_ROUTER_ENABLED", "true");
      await persistConfigEnv(
        "ELIZA_CAPABILITY_ROUTER_URLS",
        JSON.stringify([
          {
            id: "persisted-device",
            baseUrl: "https://persisted-device.example",
            token: "persisted-token",
          },
        ]),
      );

      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      loadElizaConfig();

      expect(process.env.ELIZA_CAPABILITY_ROUTER_ENABLED).toBe("true");
      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toContain(
        "persisted-token",
      );

      globalThis.fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const body =
            request.method === "POST" ? await request.json() : undefined;
          httpCalls.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          if (isInvokeBody(body, "plugin.modules.list")) {
            return jsonResponse({
              ok: true,
              result: { modules: [remoteModule] },
            });
          }
          return jsonResponse({
            ok: false,
            error: { message: `unexpected request ${request.url}` },
          });
        },
      ) as unknown as typeof fetch;

      const services = new Map<string, RemoteCapabilityRouterService>();
      const runtime = makeRuntime(null, {
        plugins: [],
        actions: [],
        providers: [],
        evaluators: [],
        routes: [],
        getSetting: () => null,
        getService: (<T>(serviceType: string): T | null =>
          (services.get(serviceType) as T | undefined) ??
          null) as IAgentRuntime["getService"],
        hasService: (serviceType) => services.has(serviceType),
        registerService: async (ServiceClass) => {
          const service = new (
            ServiceClass as typeof RemoteCapabilityRouterService
          )(runtime);
          services.set(ServiceClass.serviceType, service);
        },
        getServiceLoadPromise: async (serviceType) => {
          const service = services.get(serviceType);
          if (!service) throw new Error("service not registered");
          return service as never;
        },
        registerPlugin: async (plugin: Plugin) => {
          runtime.plugins.push(plugin);
          runtime.actions.push(...(plugin.actions ?? []));
          runtime.providers.push(...(plugin.providers ?? []));
          runtime.evaluators.push(...(plugin.evaluators ?? []));
          runtime.routes.push(...(plugin.routes ?? []));
        },
      });

      await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
        registered: [expect.objectContaining({ name: "@remote/demo" })],
        unloaded: [],
        skipped: [],
      });
      expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
        "@remote/demo",
      ]);
      expect(httpCalls).toContainEqual({
        url: "https://persisted-device.example/v1/capabilities/invoke",
        authorization: "Bearer persisted-token",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = previousStateDir;
      }
      if (previousEnabled === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_ENABLED = previousEnabled;
      }
      if (previousUrls === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_URLS = previousUrls;
      }
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("syncs multiple remote servers into executable runtime plugin components", async () => {
    const httpCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === "POST" ? await request.json() : undefined;
        httpCalls.push({ url: request.url, body });

        if (
          request.url.startsWith("https://device.example") &&
          isInvokeBody(body, "plugin.modules.list")
        ) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "device-tools",
                  name: "@remote/device-tools",
                  description: "Remote device tools.",
                  actions: [
                    {
                      name: "DEVICE_PING",
                      description: "Ping the device.",
                    },
                  ],
                  providers: [
                    {
                      name: "DEVICE_CONTEXT",
                      description: "Device context.",
                    },
                  ],
                  routes: [
                    {
                      method: "POST",
                      path: "/device/ping",
                      public: true,
                      name: "device-ping",
                    },
                  ],
                  views: [
                    {
                      id: "device.panel",
                      label: "Device Panel",
                      bundlePath: "/assets/device-panel.js",
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
                  id: "cloud-tools",
                  name: "@remote/cloud-tools",
                  description: "Remote cloud tools.",
                  actions: [
                    {
                      name: "CLOUD_SUMMARIZE",
                      description: "Summarize remotely.",
                    },
                  ],
                },
              ],
            },
          });
        }

        if (isInvokeBody(body, "plugin.action.invoke")) {
          return jsonResponse({
            ok: true,
            result: {
              text: request.url.startsWith("https://device.example")
                ? "device action"
                : "cloud action",
            },
          });
        }

        if (isInvokeBody(body, "plugin.provider.get")) {
          return jsonResponse({
            ok: true,
            result: {
              text: "device provider",
              values: { source: "device" },
            },
          });
        }

        if (isInvokeBody(body, "plugin.route.call")) {
          return jsonResponse({
            ok: true,
            result: {
              status: 201,
              headers: { "x-device": "yes" },
              body: { ping: "pong" },
            },
          });
        }

        return jsonResponse({
          ok: false,
          error: { message: "unexpected request" },
        });
      },
    ) as unknown as typeof fetch;

    const runtime = makeExecutableRuntime(
      new RemoteCapabilityRouterService(makeRuntime(null), {
        enabled: true,
        endpoints: [
          { id: "device", baseUrl: "https://device.example" },
          { id: "cloud", baseUrl: "https://cloud.example" },
        ],
        environment: "server",
        requestTimeoutMs: 1000,
      }),
    );

    await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
      registered: expect.arrayContaining([
        expect.objectContaining({ name: "@remote/device-tools" }),
        expect.objectContaining({ name: "@remote/cloud-tools" }),
      ]),
      unloaded: [],
      skipped: [],
    });

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/device-tools",
      "@remote/cloud-tools",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "DEVICE_PING",
      "CLOUD_SUMMARIZE",
    ]);
    expect(runtime.providers.map((provider) => provider.name)).toEqual([
      "DEVICE_CONTEXT",
    ]);
    expect(runtime.routes.map((route) => route.path)).toEqual(["/device/ping"]);
    expect(runtime.plugins[0]?.views?.[0]).toMatchObject({
      id: "device.panel",
      bundleUrl:
        "https://device.example/v1/capabilities/assets/device-tools/assets/device-panel.js",
    });

    await expect(
      runtime.actions
        .find((action) => action.name === "CLOUD_SUMMARIZE")
        ?.handler(runtime, { content: { topic: "runtime" } } as never),
    ).resolves.toMatchObject({ success: true, text: "cloud action" });

    await expect(
      runtime.providers[0]?.get(runtime, {} as never, {} as never),
    ).resolves.toMatchObject({
      text: "device provider",
      values: { source: "device" },
    });

    await expect(
      runtime.routes[0]?.routeHandler?.({
        runtime,
        method: "POST",
        path: "/device/ping",
        body: { id: "abc" },
        params: {},
        query: {},
        headers: {},
        inProcess: false,
      }),
    ).resolves.toEqual({
      status: 201,
      headers: { "x-device": "yes" },
      body: { ping: "pong" },
    });

    expect(httpCalls).toMatchObject([
      { url: "https://device.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
      { url: "https://cloud.example/v1/capabilities/invoke" },
      { url: "https://device.example/v1/capabilities/invoke" },
      { url: "https://device.example/v1/capabilities/invoke" },
    ]);
  });

  it("syncs and executes an authenticated plugin served by a real local capability HTTP server", async () => {
    const server = await startCapabilityHttpServer(
      makeRouter({
        listModules: async () => ({
          modules: [
            {
              id: "localhost-tools",
              name: "@remote/localhost-tools",
              description: "Local HTTP remote plugin.",
              actions: [
                {
                  name: "LOCALHOST_ACTION",
                  description: "Action over real HTTP.",
                },
              ],
              providers: [
                {
                  name: "LOCALHOST_CONTEXT",
                  description: "Provider over real HTTP.",
                },
              ],
              routes: [
                {
                  method: "POST",
                  path: "/localhost/route",
                  public: true,
                  name: "localhost-route",
                },
              ],
              views: [
                {
                  id: "localhost.panel",
                  label: "Localhost Panel",
                  bundlePath: "/assets/localhost-panel.js",
                },
              ],
            },
          ],
        }),
        invokeAction: async () => ({ text: "real http action" }),
        getProvider: async () => ({
          text: "real http provider",
          values: { transport: "http" },
        }),
        callRoute: async () => ({
          status: 203,
          headers: { "x-transport": "http" },
          body: { ok: true },
        }),
        getAsset: async ({ path }) => ({
          path,
          contentType: "text/javascript",
          bodyBase64: Buffer.from(
            "export const marker = 'remote-panel';",
          ).toString("base64"),
        }),
      }),
      { token: "local-server-token" },
    );
    try {
      const runtime = makeExecutableRuntime(
        new RemoteCapabilityRouterService(makeRuntime(null), {
          enabled: true,
          baseUrl: server.baseUrl,
          token: "local-server-token",
          environment: "server",
          requestTimeoutMs: 1000,
        }),
      );

      await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
        registered: [
          expect.objectContaining({ name: "@remote/localhost-tools" }),
        ],
        unloaded: [],
        skipped: [],
      });
      const expectedBundleUrl = `${server.baseUrl}/v1/capabilities/assets/localhost-tools/assets/localhost-panel.js`;
      expect(runtime.plugins[0]?.views?.[0]).toMatchObject({
        id: "localhost.panel",
        bundleUrl: expectedBundleUrl,
      });
      expect(getView("localhost.panel")).toMatchObject({
        id: "localhost.panel",
        pluginName: "@remote/localhost-tools",
        bundleUrl: expectedBundleUrl,
        bundleUrlVersioned: expectedBundleUrl,
        available: true,
      });
      const bundleResponse = await fetch(expectedBundleUrl, {
        headers: { authorization: "Bearer local-server-token" },
      });
      expect(bundleResponse.status).toBe(200);
      expect(bundleResponse.headers.get("content-type")).toBe(
        "text/javascript",
      );
      const bundleSource = await bundleResponse.text();
      expect(bundleSource).toBe("export const marker = 'remote-panel';");
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(
        bundleSource,
      ).toString("base64")}`;
      await expect(import(moduleUrl)).resolves.toMatchObject({
        marker: "remote-panel",
      });
      await expect(
        runtime.actions[0]?.handler(runtime, { content: {} } as never),
      ).resolves.toMatchObject({
        success: true,
        text: "real http action",
      });
      await expect(
        runtime.providers[0]?.get(runtime, {} as never, {} as never),
      ).resolves.toMatchObject({
        text: "real http provider",
        values: { transport: "http" },
      });
      await expect(
        dispatchRoute({
          runtime,
          method: "POST",
          path: "/localhost/route",
          headers: {},
          body: { ping: true },
          inProcess: false,
          isAuthorized: () => false,
        }),
      ).resolves.toEqual({
        status: 203,
        headers: { "x-transport": "http" },
        body: { ok: true },
      });

      await expect(
        runtime.routes[0]?.routeHandler?.({
          runtime,
          method: "POST",
          path: "/localhost/route",
          body: { ping: true },
          params: {},
          query: {},
          headers: {},
          inProcess: false,
        }),
      ).resolves.toEqual({
        status: 203,
        headers: { "x-transport": "http" },
        body: { ok: true },
      });
    } finally {
      await server.close();
    }
  });

  it("builds a remote plugin from source and loads it only through the capability protocol", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "eliza-remote-plugin-"));
    const srcDir = join(workspace, "src");
    const distDir = join(workspace, "dist");
    await mkdir(srcDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    const viewSource = join(srcDir, "view.ts");
    await writeFile(
      viewSource,
      [
        "export const marker = 'built-remote-view';",
        "export function render() {",
        "  return marker;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const builtBundlePath = join(distDir, "remote-view.js");
    const buildResult = await esbuild({
      entryPoints: [viewSource],
      outfile: builtBundlePath,
      target: "es2022",
      platform: "browser",
      format: "esm",
      bundle: true,
      write: true,
    });
    expect(buildResult.errors).toHaveLength(0);

    const serverSource = join(srcDir, "capability-server.mjs");
    await writeFile(
      serverSource,
      `
import { readFileSync } from "node:fs";

export function createRouter() {
  return {
    environment: "server",
    availability: async () => ({
      environment: "server",
      available: true,
      capabilities: { fs: false, pty: false, git: false, model: false, plugin: true },
    }),
    plugin: {
      listModules: async () => ({
        modules: [
          {
            id: "built-source-plugin",
            name: "@remote/built-source",
            description: "Plugin built from source in a foreign workspace.",
            actions: [{ name: "BUILT_SOURCE_ACTION", description: "Run built source action." }],
            providers: [{ name: "BUILT_SOURCE_CONTEXT", description: "Built source provider." }],
            routes: [{ method: "POST", path: "/built-source/route", public: true, name: "built-source-route" }],
            views: [{ id: "built-source.view", label: "Built Source View", bundlePath: "/assets/remote-view.js" }],
          },
        ],
      }),
      invokeAction: async ({ content }) => ({
        text: "built source action",
        data: { echo: content?.text ?? null },
      }),
      getProvider: async () => ({
        text: "built source provider",
        values: { origin: "source-build" },
      }),
      callRoute: async ({ body }) => ({
        status: 207,
        headers: { "x-built-source": "yes" },
        body: { ok: true, body },
      }),
      getAsset: async ({ path }) => {
        const source = readFileSync(${JSON.stringify(builtBundlePath)}, "utf8");
        return {
          path,
          contentType: "text/javascript",
          bodyBase64: Buffer.from(source).toString("base64"),
        };
      },
    },
  };
}
`,
      "utf8",
    );

    const { createRouter } = (await import(
      `${pathToFileURL(serverSource).href}?t=${Date.now()}`
    )) as {
      createRouter: () => ElizaCapabilityRouter;
    };
    const server = await startCapabilityHttpServer(createRouter(), {
      token: "built-source-token",
    });

    try {
      const runtime = makeExecutableRuntime(
        new RemoteCapabilityRouterService(makeRuntime(null), {
          enabled: true,
          baseUrl: server.baseUrl,
          token: "built-source-token",
          environment: "server",
          requestTimeoutMs: 1000,
        }),
      );

      await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
        registered: [expect.objectContaining({ name: "@remote/built-source" })],
        unloaded: [],
        skipped: [],
      });

      const expectedBundleUrl = `${server.baseUrl}/v1/capabilities/assets/built-source-plugin/assets/remote-view.js`;
      expect(getView("built-source.view")).toMatchObject({
        id: "built-source.view",
        pluginName: "@remote/built-source",
        bundleUrl: expectedBundleUrl,
        available: true,
      });

      const bundleResponse = await fetch(expectedBundleUrl, {
        headers: { authorization: "Bearer built-source-token" },
      });
      expect(bundleResponse.status).toBe(200);
      const bundleSource = await bundleResponse.text();
      expect(bundleSource).toContain("built-remote-view");
      await expect(
        import(
          `data:text/javascript;base64,${Buffer.from(bundleSource).toString(
            "base64",
          )}`
        ),
      ).resolves.toMatchObject({ marker: "built-remote-view" });

      await expect(
        runtime.actions[0]?.handler(runtime, {
          content: { text: "hello" },
        } as never),
      ).resolves.toMatchObject({
        success: true,
        text: "built source action",
        data: { echo: "hello" },
      });
      await expect(
        runtime.providers[0]?.get(runtime, {} as never, {} as never),
      ).resolves.toMatchObject({
        text: "built source provider",
        values: { origin: "source-build" },
      });
      await expect(
        dispatchRoute({
          runtime,
          method: "POST",
          path: "/built-source/route",
          headers: {},
          body: { ping: true },
          inProcess: false,
          isAuthorized: () => false,
        }),
      ).resolves.toEqual({
        status: 207,
        headers: { "x-built-source": "yes" },
        body: { ok: true, body: { ping: true } },
      });
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("loads a built remote plugin from a separate capability server process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "eliza-remote-process-"));
    const srcDir = join(workspace, "src");
    const distDir = join(workspace, "dist");
    await mkdir(srcDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    const viewSource = join(srcDir, "process-view.ts");
    const builtBundlePath = join(distDir, "process-view.js");
    await writeFile(
      viewSource,
      [
        "export const marker = 'process-built-remote-view';",
        "export const source = 'child-process';",
        "",
      ].join("\n"),
      "utf8",
    );
    const buildResult = await esbuild({
      entryPoints: [viewSource],
      outfile: builtBundlePath,
      target: "es2022",
      platform: "browser",
      format: "esm",
      bundle: true,
      write: true,
    });
    expect(buildResult.errors).toHaveLength(0);

    const serverSource = join(srcDir, "capability-process.mjs");
    await writeFile(
      serverSource,
      `
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const token = process.env.REMOTE_CAPABILITY_TOKEN;
const bundlePath = ${JSON.stringify(builtBundlePath)};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    if (token && req.headers.authorization !== \`Bearer \${token}\`) {
      return json(res, 401, { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "unauthorized" } });
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        environment: "server",
        available: true,
        capabilities: { fs: false, pty: false, git: false, model: false, plugin: true },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/capabilities/assets/process-plugin/assets/process-view.js") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/javascript");
      res.end(readFileSync(bundlePath));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/capabilities/invoke") {
      const body = await readBody(req);
      if (body.method === "plugin.modules.list") {
        return json(res, 200, { ok: true, result: { modules: [{
          id: "process-plugin",
          name: "@remote/process-plugin",
          description: "Remote plugin served from a child process.",
          actions: [{ name: "PROCESS_ACTION", description: "Run process action." }],
          providers: [{ name: "PROCESS_CONTEXT", description: "Process provider." }],
          routes: [{ method: "POST", path: "/process/route", public: true, name: "process-route" }],
          views: [{ id: "process.view", label: "Process View", bundlePath: "/assets/process-view.js" }],
        }] } });
      }
      if (body.method === "plugin.action.invoke") {
        return json(res, 200, { ok: true, result: { text: "process action", data: { pid: process.pid } } });
      }
      if (body.method === "plugin.provider.get") {
        return json(res, 200, { ok: true, result: { text: "process provider", values: { isolated: true } } });
      }
      if (body.method === "plugin.route.call") {
        return json(res, 200, { ok: true, result: { status: 208, headers: { "x-process-plugin": "yes" }, body: { processRoute: true, body: body.params?.body } } });
      }
      return json(res, 404, { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "unsupported method", method: body.method } });
    }
    return json(res, 404, { ok: false, error: { message: "not found" } });
  } catch (error) {
    return json(res, 500, { ok: false, error: { code: "CAPABILITY_REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  console.log(JSON.stringify({ baseUrl: \`http://127.0.0.1:\${address.port}\`, pid: process.pid }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
      "utf8",
    );

    const child = spawn(process.execPath, [serverSource], {
      env: {
        ...process.env,
        REMOTE_CAPABILITY_TOKEN: "process-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const { baseUrl, pid } = await readChildServerReady(child);
      expect(pid).not.toBe(process.pid);
      const runtime = makeExecutableRuntime(
        new RemoteCapabilityRouterService(makeRuntime(null), {
          enabled: true,
          baseUrl,
          token: "process-token",
          environment: "server",
          requestTimeoutMs: 1000,
        }),
      );

      await expect(bootstrapRemoteCapabilityPlugins(runtime)).resolves.toEqual({
        registered: [
          expect.objectContaining({ name: "@remote/process-plugin" }),
        ],
        unloaded: [],
        skipped: [],
      });

      const bundleUrl = `${baseUrl}/v1/capabilities/assets/process-plugin/assets/process-view.js`;
      expect(getView("process.view")).toMatchObject({
        id: "process.view",
        pluginName: "@remote/process-plugin",
        bundleUrl,
        available: true,
      });
      const bundleResponse = await fetch(bundleUrl, {
        headers: { authorization: "Bearer process-token" },
      });
      expect(bundleResponse.status).toBe(200);
      const bundleSource = await bundleResponse.text();
      await expect(
        import(
          `data:text/javascript;base64,${Buffer.from(bundleSource).toString(
            "base64",
          )}`
        ),
      ).resolves.toMatchObject({
        marker: "process-built-remote-view",
        source: "child-process",
      });

      await expect(
        runtime.actions[0]?.handler(runtime, { content: {} } as never),
      ).resolves.toMatchObject({
        success: true,
        text: "process action",
        data: { pid },
      });
      await expect(
        runtime.providers[0]?.get(runtime, {} as never, {} as never),
      ).resolves.toMatchObject({
        text: "process provider",
        values: { isolated: true },
      });
      await expect(
        dispatchRoute({
          runtime,
          method: "POST",
          path: "/process/route",
          headers: {},
          body: { process: true },
          inProcess: false,
          isAuthorized: () => false,
        }),
      ).resolves.toEqual({
        status: 208,
        headers: { "x-process-plugin": "yes" },
        body: { processRoute: true, body: { process: true } },
      });
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  dockerSmoke(
    "loads a built remote plugin from an actual Docker container capability server",
    async () => {
      await expectDockerAvailable();
      const workspace = await mkdtemp(join(tmpdir(), "eliza-remote-docker-"));
      const srcDir = join(workspace, "src");
      const distDir = join(workspace, "dist");
      await mkdir(srcDir, { recursive: true });
      await mkdir(distDir, { recursive: true });

      const viewSource = join(srcDir, "docker-view.ts");
      const builtBundlePath = join(distDir, "docker-view.js");
      await writeFile(
        viewSource,
        [
          "export const marker = 'docker-built-remote-view';",
          "export const isolation = 'docker';",
          "",
        ].join("\n"),
        "utf8",
      );
      const buildResult = await esbuild({
        entryPoints: [viewSource],
        outfile: builtBundlePath,
        target: "es2022",
        platform: "browser",
        format: "esm",
        bundle: true,
        write: true,
      });
      expect(buildResult.errors).toHaveLength(0);

      await writeFile(
        join(workspace, "server.mjs"),
        `
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const token = process.env.REMOTE_CAPABILITY_TOKEN;
const port = Number(process.env.PORT || 8080);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

createServer(async (req, res) => {
  try {
    if (token && req.headers.authorization !== \`Bearer \${token}\`) {
      return json(res, 401, { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "unauthorized" } });
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        environment: "server",
        available: true,
        capabilities: { fs: false, pty: false, git: false, model: false, plugin: true },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/capabilities/assets/docker-plugin/assets/docker-view.js") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/javascript");
      res.end(readFileSync("/app/dist/docker-view.js"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/capabilities/invoke") {
      const body = await readBody(req);
      if (body.method === "plugin.modules.list") {
        return json(res, 200, { ok: true, result: { modules: [{
          id: "docker-plugin",
          name: "@remote/docker-plugin",
          description: "Remote plugin served from a Docker container.",
          actions: [{ name: "DOCKER_ACTION", description: "Run Docker action." }],
          providers: [{ name: "DOCKER_CONTEXT", description: "Docker provider." }],
          routes: [{ method: "POST", path: "/docker/route", public: true, name: "docker-route" }],
          views: [{ id: "docker.view", label: "Docker View", bundlePath: "/assets/docker-view.js" }],
        }] } });
      }
      if (body.method === "plugin.action.invoke") {
        return json(res, 200, { ok: true, result: { text: "docker action", data: { container: true } } });
      }
      if (body.method === "plugin.provider.get") {
        return json(res, 200, { ok: true, result: { text: "docker provider", values: { isolated: "container" } } });
      }
      if (body.method === "plugin.route.call") {
        return json(res, 200, { ok: true, result: { status: 209, headers: { "x-docker-plugin": "yes" }, body: { dockerRoute: true, body: body.params?.body } } });
      }
      return json(res, 404, { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "unsupported method", method: body.method } });
    }
    return json(res, 404, { ok: false, error: { message: "not found" } });
  } catch (error) {
    return json(res, 500, { ok: false, error: { code: "CAPABILITY_REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) } });
  }
}).listen(port, "0.0.0.0");
`,
        "utf8",
      );
      await writeFile(
        join(workspace, "Dockerfile"),
        [
          "FROM node:24-alpine",
          "WORKDIR /app",
          "COPY server.mjs /app/server.mjs",
          "COPY dist/docker-view.js /app/dist/docker-view.js",
          "ENV PORT=8080",
          'CMD ["node", "/app/server.mjs"]',
          "",
        ].join("\n"),
        "utf8",
      );

      const tag = `eliza-remote-capability-smoke:${Date.now()}`;
      let containerId: string | null = null;
      try {
        await execFileText("docker", ["build", "-t", tag, workspace], {
          timeoutMs: 180_000,
        });
        containerId = (
          await execFileText("docker", [
            "run",
            "-d",
            "-p",
            "127.0.0.1::8080",
            "-e",
            "REMOTE_CAPABILITY_TOKEN=docker-token",
            tag,
          ])
        ).trim();
        const portOutput = await execFileText("docker", [
          "port",
          containerId,
          "8080/tcp",
        ]);
        const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)/);
        if (!portMatch?.[1]) {
          throw new Error(`Could not read Docker mapped port: ${portOutput}`);
        }
        const baseUrl = `http://127.0.0.1:${portMatch[1]}`;
        await waitForCapabilityEndpoint(baseUrl, "docker-token");

        const runtime = makeExecutableRuntime(
          new RemoteCapabilityRouterService(makeRuntime(null), {
            enabled: true,
            baseUrl,
            token: "docker-token",
            environment: "server",
            requestTimeoutMs: 1000,
          }),
        );

        await expect(
          bootstrapRemoteCapabilityPlugins(runtime),
        ).resolves.toEqual({
          registered: [
            expect.objectContaining({ name: "@remote/docker-plugin" }),
          ],
          unloaded: [],
          skipped: [],
        });

        const bundleUrl = `${baseUrl}/v1/capabilities/assets/docker-plugin/assets/docker-view.js`;
        expect(getView("docker.view")).toMatchObject({
          id: "docker.view",
          pluginName: "@remote/docker-plugin",
          bundleUrl,
          available: true,
        });
        const bundleResponse = await fetch(bundleUrl, {
          headers: { authorization: "Bearer docker-token" },
        });
        expect(bundleResponse.status).toBe(200);
        const bundleSource = await bundleResponse.text();
        await expect(
          import(
            `data:text/javascript;base64,${Buffer.from(bundleSource).toString(
              "base64",
            )}`
          ),
        ).resolves.toMatchObject({
          marker: "docker-built-remote-view",
          isolation: "docker",
        });
        await expect(
          runtime.actions[0]?.handler(runtime, { content: {} } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "docker action",
          data: { container: true },
        });
        await expect(
          runtime.providers[0]?.get(runtime, {} as never, {} as never),
        ).resolves.toMatchObject({
          text: "docker provider",
          values: { isolated: "container" },
        });
        await expect(
          dispatchRoute({
            runtime,
            method: "POST",
            path: "/docker/route",
            headers: {},
            body: { docker: true },
            inProcess: false,
            isAuthorized: () => false,
          }),
        ).resolves.toEqual({
          status: 209,
          headers: { "x-docker-plugin": "yes" },
          body: { dockerRoute: true, body: { docker: true } },
        });
      } finally {
        if (containerId) {
          await execFileText("docker", ["rm", "-f", containerId]).catch(
            () => "",
          );
        }
        await execFileText("docker", ["rmi", "-f", tag]).catch(() => "");
        await rm(workspace, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it("throws a structured capability error without a router service", async () => {
    const runtime = makeRuntime(null);

    await expect(
      registerRemoteCapabilityPlugins(runtime, { modules: [remoteModule] }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
    });
    expect(() => createRemoteCapabilityPlugin(remoteModule)).not.toThrow();
    await expect(
      createRemoteCapabilityPlugin(remoteModule).actions?.[0]?.handler(
        runtime,
        { content: {} } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

function makeRuntime(
  router: ElizaCapabilityRouter | null,
  overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
  return {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Remote Plugin Test" },
    getService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE ? router : null,
    registerPlugin: async () => {},
    reloadPlugin: async (plugin: Plugin) => {
      await overrides.registerPlugin?.(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () => [],
    hasService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE && router !== null,
    getServiceLoadPromise: async () => {
      if (!router) throw new Error("router not configured");
      return router as never;
    },
    ...overrides,
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

function makeExecutableRuntime(router: ElizaCapabilityRouter): IAgentRuntime {
  const runtime = makeRuntime(router, {
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    routes: [],
  });
  runtime.registerPlugin = async (plugin: Plugin) => {
    runtime.plugins.push(plugin);
    runtime.actions.push(...(plugin.actions ?? []));
    runtime.providers.push(...(plugin.providers ?? []));
    runtime.evaluators.push(...(plugin.evaluators ?? []));
    runtime.routes.push(...(plugin.routes ?? []));
    await registerPluginViews(plugin);
  };
  return runtime;
}

function makeRouter(
  overrides: Partial<ElizaCapabilityRouter["plugin"]> = {},
): ElizaCapabilityRouter {
  const unavailable = async () => {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "not implemented",
      capability: "plugin",
    });
  };
  return {
    environment: "server",
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
    fs: {
      list: unavailable,
      readText: unavailable,
      writeText: unavailable,
    },
    pty: { runCommand: unavailable },
    git: {
      status: unavailable,
      diff: unavailable,
      commandRun: unavailable,
    },
    model: { status: unavailable },
    plugin: {
      listModules: unavailable,
      invokeAction: unavailable,
      getProvider: unavailable,
      callRoute: unavailable,
      getAsset: unavailable,
      shouldRunEvaluator: unavailable,
      prepareEvaluator: unavailable,
      promptEvaluator: unavailable,
      processEvaluator: unavailable,
      handleEvent: unavailable,
      invokeModel: unavailable,
      callAppBridge: unavailable,
      ...overrides,
    },
  };
}

function readChildServerReady(
  child: CapabilityServerChild,
): Promise<{ baseUrl: string; pid: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child server. ${stderr}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find((item) => item.trim());
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "baseUrl" in parsed &&
          "pid" in parsed &&
          typeof parsed.baseUrl === "string" &&
          typeof parsed.pid === "number"
        ) {
          cleanup();
          resolve({ baseUrl: parsed.baseUrl, pid: parsed.pid });
        }
      } catch {
        // Keep waiting for a JSON readiness line.
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Child capability server exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForChildExit(child: CapabilityServerChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function execFileText(
  file: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.join(" ")} failed: ${error.message}\n${stderr}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function expectDockerAvailable(): Promise<void> {
  await expect(
    execFileText("docker", ["info"], { timeoutMs: 15_000 }),
  ).resolves.toEqual(expect.any(String));
}

async function waitForCapabilityEndpoint(
  baseUrl: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for Docker capability endpoint: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function startCapabilityHttpServer(
  router: ElizaCapabilityRouter,
  options: { token?: string } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const handler = createRemoteCapabilityFetchHandler(router, options);
  const server = createServer(async (req, res) => {
    try {
      const request = await requestFromIncoming(req);
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function requestFromIncoming(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

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
