import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  type Service,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistConfigEnv } from "../api/config-env.ts";
import { dispatchRoute } from "../api/dispatch-route.ts";
import { handleRemoteCapabilityRoutes } from "../api/remote-capability-routes.ts";
import {
  getView,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import {
  importAppRouteModule,
  registerRuntimeAppRouteModule,
  unregisterRuntimeAppRouteModule,
} from "./app-package-modules.ts";
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
  priority: 90,
  contexts: ["general", "remote-demo"],
  config: {
    REMOTE_MODE: "demo",
    retryCount: 2,
    enabled: true,
    nullable: null,
    remoteCapabilityModuleId: "remote-owned-value",
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
  responseHandlerEvaluators: [
    {
      name: "REMOTE_RESPONSE_HANDLER",
      description: "Patch response handler output remotely.",
      priority: 35,
    },
  ],
  responseHandlerFieldEvaluators: [
    {
      name: "remoteHints",
      description: "Remote field evaluator hints for the response handler.",
      priority: 45,
      schema: {
        type: "array",
        items: { type: "string" },
      },
      hasParse: true,
      hasHandle: true,
    },
  ],
  events: [{ eventName: "REMOTE_EVENT" }],
  models: [{ modelType: "REMOTE_TEXT", priority: 75 }],
  services: [
    {
      serviceType: "remote_demo_service",
      capabilityDescription: "Remote demo service.",
      methods: ["lookup", "stop"],
      config: { region: "remote" },
    },
  ],
  componentTypes: [
    {
      name: "remote-demo.component",
      schema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Remote message." },
          priority: { type: "number" },
        },
        required: ["message"],
      },
    },
  ],
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
  lifecycle: {
    hooks: ["init", "dispose", "applyConfig"],
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

function hashRemotePluginModuleForTest(
  module: RemotePluginModuleManifest,
): string {
  const {
    capabilityEndpointId: _endpointId,
    provenance: _provenance,
    ...rest
  } = module;
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForTest(rest)), "utf8")
    .digest("hex");
}

function canonicalizeForTest(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((entry) => canonicalizeForTest(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeForTest(entry)]),
    );
  }
  return value;
}

async function buildRemoteViewFixtures({
  entryPoints,
  outfile,
  outdir,
}: {
  entryPoints: string[];
  outfile?: string;
  outdir?: string;
}) {
  for (const entryPoint of entryPoints) {
    const source = await readFile(entryPoint, "utf8");
    const outputPath =
      outfile ??
      join(
        outdir ?? dirname(entryPoint),
        basename(entryPoint).replace(/\.[cm]?tsx?$/, ".js"),
      );
    await writeFile(outputPath, source, "utf8");
  }
  return { errors: [] };
}

const originalFetch = globalThis.fetch;
type CapabilityServerChild = ChildProcessByStdio<null, Readable, Readable>;
const dockerSmoke =
  process.env.ELIZA_REMOTE_CAPABILITY_DOCKER_SMOKE === "1" ? it : it.skip;
// esbuild's platform-specific binary (`@esbuild/<platform>`) isn't always
// resolvable under bun's nested workspace install layout in CI; these tests
// shell out to esbuild's JS API which then errors with
// "paths[0] argument must be of type string" when the bin lookup fails.
// Gate behind ELIZA_REMOTE_PLUGIN_BUILD_SMOKE so local runs (where esbuild
// works) still exercise the path and CI doesn't fail on infra plumbing.
const esbuildSmoke =
  process.env.ELIZA_REMOTE_PLUGIN_BUILD_SMOKE === "1" ? it : it.skip;
const registeredViewPlugins = [
  "@remote/device-tools",
  "@remote/cloud-tools",
  "@remote/device-a",
  "@remote/device-b",
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
    unregisterRuntimeAppRouteModule("@remote/demo");
    unregisterRuntimeAppRouteModule("@remote/plugin-weather");
    unregisterRuntimeAppRouteModule("@remote/weather");
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
          headers: {
            "x-remote": "yes",
            "set-cookie": "remote_session=secret",
            authorization: "Bearer remote-secret",
          },
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
      shouldRunResponseHandlerEvaluator: async (params) => {
        calls.push({ method: "responseHandler.shouldRun", params });
        return { shouldRun: true };
      },
      evaluateResponseHandlerEvaluator: async (params) => {
        calls.push({ method: "responseHandler.evaluate", params });
        return {
          patch: {
            reply: "remote response patch",
            addCandidateActions: ["REMOTE_DEMO"],
            debug: ["remote response handler"],
          },
        };
      },
      shouldRunResponseHandlerFieldEvaluator: async (params) => {
        calls.push({ method: "responseHandlerField.shouldRun", params });
        return { shouldRun: true };
      },
      parseResponseHandlerFieldEvaluator: async (params) => {
        calls.push({ method: "responseHandlerField.parse", params });
        return {
          value: Array.isArray(params.value)
            ? params.value.map((item) => String(item).toUpperCase())
            : [],
        };
      },
      handleResponseHandlerFieldEvaluator: async (params) => {
        calls.push({ method: "responseHandlerField.handle", params });
        return {
          effect: {
            patch: {
              candidateActionNames: ["REMOTE_DEMO"],
              remoteHintsHandled: true,
            },
            debug: ["remote field handled"],
          },
        };
      },
      callLifecycle: async (params) => {
        calls.push({ method: "lifecycle", params });
        return { ok: true };
      },
      handleEvent: async (params) => {
        calls.push({ method: "event", params });
        return { handled: true };
      },
      invokeModel: async (params) => {
        calls.push({ method: "model", params });
        return { result: "remote model result" };
      },
      callService: async (params) => {
        calls.push({ method: "service", params });
        return { result: { ok: true, args: params.args ?? [] } };
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
              headers: {
                "x-remote-app-route": "yes",
                "set-cookie": "remote_app_session=secret",
                "x-auth-token": "remote-auth-token",
              },
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
      schema: {
        remote_demo_records: {
          id: "uuid",
          message: "text",
        },
      },
      config: {
        REMOTE_MODE: "demo",
        retryCount: 2,
        enabled: true,
        nullable: null,
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
    expect(plugin.priority).toBe(90);
    expect(plugin.contexts).toEqual(["general", "remote-demo"]);
    expect(plugin.componentTypes).toEqual(remoteModule.componentTypes);
    expect(plugin.services?.[0]?.serviceType).toBe("remote_demo_service");
    const remoteService = await plugin.services?.[0]?.start(runtime);
    expect(remoteService).toMatchObject({
      capabilityDescription: "Remote demo service.",
      config: { region: "remote" },
    });
    await expect(
      (
        remoteService as typeof remoteService & {
          lookup(input: unknown): Promise<unknown>;
        }
      ).lookup({ query: "demo" }),
    ).resolves.toEqual({ ok: true, args: [{ query: "demo" }] });
    await plugin.init?.(stringifyPluginConfig(plugin.config ?? {}), runtime);
    await plugin.applyConfig?.({ mode: "updated" }, runtime);
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
          headers: {
            accept: "application/json",
            authorization: "Bearer local",
            cookie: "sid=local-session",
            "x-auth-token": "local-auth-token",
          },
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
    expect(routeResponse.headers).not.toHaveProperty("set-cookie");
    expect(routeResponse.headers).not.toHaveProperty("x-auth-token");
    expect(JSON.parse(routeResponse.ended)).toEqual({
      ok: true,
      method: "POST",
      body: { command: "ping" },
    });
    await plugin.dispose?.(runtime);
    await remoteService?.stop();
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: "lifecycle",
          params: {
            moduleId: "remote-demo",
            hook: "init",
            config: {
              REMOTE_MODE: "demo",
              retryCount: "2",
              enabled: "true",
              remoteCapabilityModuleId: "remote-demo",
              remoteCapabilityVersion: "1.2.3",
            },
          },
        },
        {
          method: "lifecycle",
          params: {
            moduleId: "remote-demo",
            hook: "applyConfig",
            config: { mode: "updated" },
          },
        },
        {
          method: "lifecycle",
          params: {
            moduleId: "remote-demo",
            hook: "dispose",
          },
        },
        {
          method: "service",
          params: {
            moduleId: "remote-demo",
            serviceType: "remote_demo_service",
            method: "lookup",
            args: [{ query: "demo" }],
          },
        },
        {
          method: "service",
          params: {
            moduleId: "remote-demo",
            serviceType: "remote_demo_service",
            method: "stop",
            args: [],
          },
        },
      ]),
    );

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
        headers: {
          accept: "application/json",
          authorization: "Bearer local-agent-secret",
          cookie: "sid=local-session",
          "x-api-key": "local-api-key",
        },
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
    expect(plugin.responseHandlerEvaluators?.[0]).toMatchObject({
      name: "REMOTE_RESPONSE_HANDLER",
      description: "Patch response handler output remotely.",
      priority: 35,
    });
    expect(plugin.responseHandlerFieldEvaluators?.[0]).toMatchObject({
      name: "remoteHints",
      description: "Remote field evaluator hints for the response handler.",
      priority: 45,
      schema: {
        type: "array",
        items: { type: "string" },
      },
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
    const responseHandlerContext = {
      runtime,
      message: evaluatorContext.message,
      state: evaluatorContext.state,
      messageHandler: {
        processMessage: "RESPOND",
        thought: "base thought",
        plan: {
          contexts: ["general"],
          candidateActions: [],
        },
      },
      availableContexts: [{ id: "general", description: "General context" }],
    };
    await expect(
      plugin.responseHandlerEvaluators?.[0]?.shouldRun(
        responseHandlerContext as never,
      ),
    ).resolves.toBe(true);
    await expect(
      plugin.responseHandlerEvaluators?.[0]?.evaluate(
        responseHandlerContext as never,
      ),
    ).resolves.toEqual({
      reply: "remote response patch",
      addCandidateActions: ["REMOTE_DEMO"],
      debug: ["remote response handler"],
    });
    const responseHandlerFieldContext = {
      runtime,
      message: evaluatorContext.message,
      state: evaluatorContext.state,
      senderRole: "OWNER",
      turnSignal: new AbortController().signal,
    };
    await expect(
      plugin.responseHandlerFieldEvaluators?.[0]?.shouldRun?.(
        responseHandlerFieldContext as never,
      ),
    ).resolves.toBe(true);
    await expect(
      plugin.responseHandlerFieldEvaluators?.[0]?.parse?.(
        ["alpha", "beta"],
        responseHandlerFieldContext as never,
      ),
    ).resolves.toEqual(["ALPHA", "BETA"]);
    const fieldEffect =
      await plugin.responseHandlerFieldEvaluators?.[0]?.handle?.({
        ...responseHandlerFieldContext,
        value: ["ALPHA"],
        parsed: {
          shouldRespond: "RESPOND",
          contexts: ["general"],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
          remoteHints: ["ALPHA"],
        },
      } as never);
    const mutableResult = {
      shouldRespond: "RESPOND" as const,
      contexts: ["general"],
      intents: [],
      candidateActionNames: [],
      replyText: "",
      facts: [],
      relationships: [],
      addressedTo: [],
    };
    fieldEffect?.mutateResult?.(mutableResult);
    expect(mutableResult).toMatchObject({
      candidateActionNames: ["REMOTE_DEMO"],
      remoteHintsHandled: true,
    });
    expect(fieldEffect?.debug).toEqual(["remote field handled"]);
    await expect(
      (
        plugin.events as Record<
          string,
          Array<(payload: unknown) => Promise<void> | void>
        >
      )?.REMOTE_EVENT?.[0]?.({
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
    expect(plugin.priority).toBe(90);

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
          method: "responseHandler.shouldRun",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            evaluator: "REMOTE_RESPONSE_HANDLER",
            context: expect.objectContaining({
              message: expect.objectContaining({
                id: "22222222-2222-2222-2222-222222222222",
              }),
              messageHandler: expect.objectContaining({
                processMessage: "RESPOND",
              }),
              availableContexts: [
                { id: "general", description: "General context" },
              ],
            }),
          }),
        },
        {
          method: "responseHandler.evaluate",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            evaluator: "REMOTE_RESPONSE_HANDLER",
          }),
        },
        {
          method: "responseHandlerField.shouldRun",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            field: "remoteHints",
            context: expect.objectContaining({
              senderRole: "OWNER",
            }),
          }),
        },
        {
          method: "responseHandlerField.parse",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            field: "remoteHints",
            value: ["alpha", "beta"],
          }),
        },
        {
          method: "responseHandlerField.handle",
          params: expect.objectContaining({
            moduleId: "remote-demo",
            field: "remoteHints",
            value: ["ALPHA"],
            parsed: expect.objectContaining({
              remoteHints: ["ALPHA"],
            }),
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
              headers: { accept: "application/json" },
              body: { command: "ping" },
            }),
          }),
        }),
      ]),
    );
  });

  it("registers remote modules through runtime.registerPlugin", async () => {
    const router = makeRouter({
      listModules: async () => ({ modules: [remoteModule] }),
      callService: async (params) => ({
        result: { ok: true, serviceType: params.serviceType },
      }),
    });
    const runtime = makeExecutableRuntime(router);

    await expect(registerRemoteCapabilityPlugins(runtime)).resolves.toEqual([
      expect.objectContaining({ name: "@remote/demo" }),
    ]);
    expect(runtime.plugins).toHaveLength(1);
    await expect(
      runtime.getServiceLoadPromise("remote_demo_service"),
    ).resolves.toMatchObject({
      capabilityDescription: "Remote demo service.",
      config: { region: "remote" },
    });
    const service = await runtime.getServiceLoadPromise("remote_demo_service");
    await expect(
      (
        service as typeof service & {
          lookup(input: unknown): Promise<unknown>;
        }
      ).lookup({ query: "registered" }),
    ).resolves.toEqual({
      ok: true,
      serviceType: "remote_demo_service",
    });
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

  it("rejects duplicate remote view ids in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-view-copy",
            name: "@remote/view-copy",
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            events: [],
            models: [],
            services: [],
            routes: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote view collision for "gui:remote-view" between modules "remote-demo" and "remote-view-copy".',
    });
  });

  it("rejects remote views that collide with local runtime views", async () => {
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        {
          name: "@local/views",
          description: "Local plugin with an existing view",
          views: [
            {
              id: "remote-view",
              label: "Local View",
              viewType: "gui",
            },
          ],
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
        'Remote plugin "remote-demo" view "gui:remote-view" would collide with an existing runtime view.',
    });
  });

  it("rejects duplicate remote widget ids for the same widget plugin key", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-widget-copy",
            name: "@remote/widget-copy",
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            events: [],
            models: [],
            services: [],
            routes: [],
            views: [],
            widgets: [
              {
                id: "remote.widget",
                pluginId: "@remote/demo",
                slot: "chat-sidebar",
                label: "Remote Widget Copy",
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote widget collision for "@remote/demo/remote.widget" between modules "remote-demo" and "remote-widget-copy".',
    });
  });

  it("rejects remote widgets that collide with local runtime widgets", async () => {
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        {
          name: "@local/widgets",
          description: "Local plugin with an existing widget",
          widgets: [
            {
              id: "remote.widget",
              pluginId: "@remote/demo",
              slot: "chat-sidebar",
              label: "Local Widget",
            },
          ],
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
        'Remote plugin "remote-demo" widget "@remote/demo/remote.widget" would collide with an existing runtime widget.',
    });
  });

  it("rejects duplicate remote app nav tab ids in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-nav-copy",
            name: "@remote/nav-copy",
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            events: [],
            models: [],
            services: [],
            routes: [],
            views: [],
            widgets: [],
            appBridge: undefined,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote app nav tab collision for "remote.demo" between modules "remote-demo" and "remote-nav-copy".',
    });
  });

  it("rejects remote app nav tabs that collide with local runtime nav tabs", async () => {
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        {
          name: "@local/nav",
          description: "Local plugin with an existing app nav tab",
          app: {
            displayName: "Local Nav",
            navTabs: [
              {
                id: "remote.demo",
                label: "Local Remote Demo",
                path: "/local-remote-demo",
              },
            ],
          },
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
        'Remote plugin "remote-demo" app nav tab "remote.demo" would collide with an existing runtime app nav tab.',
    });
  });

  it("rejects remote app bridge identifiers that normalize to the same route key", async () => {
    const runtime = makeRuntime(makeRouter());
    const firstModule: RemotePluginModuleManifest = {
      id: "plugin-weather",
      name: "@remote/plugin-weather",
      appBridge: { hooks: ["handleAppRoutes"] },
    };
    const secondModule: RemotePluginModuleManifest = {
      id: "weather",
      name: "@remote/weather",
      appBridge: { hooks: ["handleAppRoutes"] },
    };

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [firstModule, secondModule],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote app bridge identifier collision for "weather" between modules "plugin-weather" (@remote/plugin-weather) and "weather" (@remote/weather).',
    });
  });

  it("rejects remote app bridges that collide with existing runtime app route modules", async () => {
    const runtime = makeRuntime(makeRouter());
    registerRuntimeAppRouteModule("@remote/demo", {
      handleAppRoutes: async () => true,
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
            models: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" app bridge route key "demo" would collide with an existing runtime app route module.',
    });
  });

  it("enforces remote plugin trust policy before registration", async () => {
    const runtime = makeRuntime(makeRouter());
    const trustedModule = {
      ...remoteModule,
      capabilityEndpointId: "trusted-cloud",
    };

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [trustedModule],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          allowedModuleIds: ["remote-demo"],
          requireEndpointId: true,
        },
      }),
    ).resolves.toMatchObject({
      registered: [{ name: "@remote/demo" }],
      skipped: [],
      unloaded: [],
      trustDecisions: [
        {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          trusted: true,
          reason: "allowed",
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            capabilityEndpointId: "unknown-cloud",
          },
        ],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" comes from untrusted capability endpoint "unknown-cloud".',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "unknown-cloud",
          trusted: false,
          reason: "endpoint-not-allowed",
        },
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [remoteModule],
        trustPolicy: {
          requireEndpointId: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" does not declare a trusted capability endpoint id.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          trusted: false,
          reason: "missing-endpoint-id",
        },
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [trustedModule],
        trustPolicy: {
          allowedModuleIds: ["other-module"],
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" is not trusted for registration.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          trusted: false,
          reason: "module-not-allowed",
        },
      },
    });

    const signedModule: RemotePluginModuleManifest = {
      ...trustedModule,
      provenance: {
        issuer: "eliza-cloud-build",
        subject: "cloud://agents/trusted-cloud/modules/remote-demo",
        digestSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        signatureAlgorithm: "ed25519",
        signature: "signed-remote-demo",
      },
    };
    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [signedModule],
        reloadExisting: true,
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          allowedModuleIds: ["remote-demo"],
          allowedProvenanceIssuers: ["eliza-cloud-build"],
          requireEndpointId: true,
          requireSignedProvenance: true,
        },
      }),
    ).resolves.toMatchObject({
      registered: [{ name: "@remote/demo" }],
      trustDecisions: [
        {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: true,
          reason: "allowed",
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [trustedModule],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          requireSignedProvenance: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" does not include signed provenance.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          trusted: false,
          reason: "missing-provenance",
        },
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [signedModule],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          allowedProvenanceIssuers: ["other-issuer"],
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" provenance issuer "eliza-cloud-build" is not trusted for registration.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: false,
          reason: "provenance-issuer-not-allowed",
        },
      },
    });

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    const verifiedDigest = hashRemotePluginModuleForTest(trustedModule);
    const verifiedProvenance = {
      issuer: "eliza-cloud-build",
      subject: "cloud://agents/trusted-cloud/modules/remote-demo",
      digestSha256: verifiedDigest,
      signatureAlgorithm: "ed25519",
      signature: "",
    };
    const verifiedModule: RemotePluginModuleManifest = {
      ...trustedModule,
      provenance: {
        ...verifiedProvenance,
        signature: sign(
          null,
          Buffer.from(
            [
              `issuer:${verifiedProvenance.issuer}`,
              `subject:${verifiedProvenance.subject}`,
              `digestSha256:${verifiedProvenance.digestSha256}`,
            ].join("\n"),
            "utf8",
          ),
          privateKey,
        ).toString("base64"),
      },
    };
    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [verifiedModule],
        reloadExisting: true,
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          allowedProvenanceIssuers: ["eliza-cloud-build"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build": publicKeyPem,
          },
          requireEndpointId: true,
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
        },
      }),
    ).resolves.toMatchObject({
      registered: [{ name: "@remote/demo" }],
      trustDecisions: [
        {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: true,
          reason: "allowed",
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...verifiedModule,
            provenance: {
              ...verifiedModule.provenance!,
              signature: "not-a-valid-signature",
            },
          },
        ],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build": publicKeyPem,
          },
          requireVerifiedProvenance: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" provenance signature is invalid.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: false,
          reason: "invalid-provenance-signature",
        },
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...verifiedModule,
            description: "Tampered remote demo plugin.",
          },
        ],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build": publicKeyPem,
          },
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" provenance digest does not match module contents.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: false,
          reason: "invalid-provenance-digest",
        },
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [verifiedModule],
        trustPolicy: {
          allowedEndpointIds: ["trusted-cloud"],
          requireVerifiedProvenance: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" provenance issuer "eliza-cloud-build" has no trusted verification key.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          provenanceIssuer: "eliza-cloud-build",
          trusted: false,
          reason: "missing-provenance-public-key",
        },
      },
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

  it("rejects duplicate remote service types in the same sync batch", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          remoteModule,
          {
            ...remoteModule,
            id: "remote-service-copy",
            name: "@remote/service-copy",
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            models: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote service type collision for "remote_demo_service" between modules "remote-demo" and "remote-service-copy".',
    });
  });

  it("rejects remote services that collide with local runtime services", async () => {
    const runtime = makeRuntime(makeRouter(), {
      hasService: (serviceType: string) =>
        serviceType === CAPABILITY_ROUTER_SERVICE_TYPE ||
        serviceType === "remote_demo_service",
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            models: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" service "remote_demo_service" would collide with an existing runtime service.',
    });
  });

  it("rejects duplicate model declarations inside one remote module", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
            models: [
              { modelType: "REMOTE_TEXT", priority: 10 },
              { modelType: "REMOTE_TEXT", priority: 20 },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" declares model "REMOTE_TEXT" more than once.',
    });
  });

  it("rejects duplicate model declarations across remote modules", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
          },
          {
            ...remoteModule,
            id: "remote-model-copy",
            name: "@remote/model-copy",
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote model collision for "REMOTE_TEXT" between modules "remote-demo" and "remote-model-copy".',
    });
  });

  it("rejects remote models that collide with local runtime models", async () => {
    const runtime = makeRuntime(makeRouter(), {
      plugins: [
        {
          name: "@local/model",
          description: "Local model plugin",
          models: {
            REMOTE_TEXT: async () => ({ text: "local" }) as never,
          } as never,
        },
      ],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" model "REMOTE_TEXT" would collide with an existing runtime model.',
    });
  });

  it("rejects named component reuse from a different registered remote module", async () => {
    const registeredRemote = createRemoteCapabilityPlugin(remoteModule);
    const runtime = makeRuntime(makeRouter(), {
      plugins: [registeredRemote],
      actions: registeredRemote.actions,
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            id: "remote-action-copy",
            name: "@remote/action-copy",
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            routes: [],
            services: [],
            models: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote action name collision for "REMOTE_DEMO" between registered module "remote-demo" and module "remote-action-copy".',
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
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            services: [],
            models: [],
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

  it("rejects remote STATIC routes until a remote static mount contract exists", async () => {
    const runtime = makeRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          {
            ...remoteModule,
            actions: [],
            providers: [],
            evaluators: [],
            responseHandlerEvaluators: [],
            responseHandlerFieldEvaluators: [],
            services: [],
            models: [],
            routes: [
              {
                method: "STATIC",
                path: "/remote/static",
                public: true,
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DECODE_FAILED",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin "remote-demo" route "/remote/static" uses STATIC, which is not supported by the remote plugin adapter. Use plugin assets or a dynamic HTTP route instead.',
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
      trustDecisions: [],
    });
    expect(unloaded).toEqual(["@remote/demo"]);
  });

  it("removes stale runtime contributions when a remote module disappears", async () => {
    const module: RemotePluginModuleManifest = {
      id: "volatile-remote",
      name: "@remote/volatile",
      capabilityEndpointId: "device-a",
      actions: [
        {
          name: "VOLATILE_ACTION",
          description: "Action removed with the remote module.",
        },
      ],
      providers: [
        {
          name: "VOLATILE_CONTEXT",
          description: "Provider removed with the remote module.",
        },
      ],
      routes: [
        {
          method: "POST",
          path: "/volatile/route",
          public: true,
        },
      ],
      views: [
        {
          id: "volatile.view",
          label: "Volatile View",
          bundleUrl: "https://device-a.example/volatile-view.js",
        },
      ],
    };
    const runtime = makeLifecycleRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [module],
        trustPolicy: {
          allowedEndpointIds: ["device-a"],
          allowedModuleIds: ["volatile-remote"],
          requireEndpointId: true,
        },
      }),
    ).resolves.toMatchObject({
      registered: [expect.objectContaining({ name: "@remote/volatile" })],
      unloaded: [],
    });
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/volatile",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "VOLATILE_ACTION",
    ]);
    expect(runtime.providers.map((provider) => provider.name)).toEqual([
      "VOLATILE_CONTEXT",
    ]);
    expect(runtime.routes.map((route) => route.path)).toEqual([
      "/volatile/route",
    ]);
    expect(getView("volatile.view")).toMatchObject({
      pluginName: "@remote/volatile",
      bundleUrl: "https://device-a.example/volatile-view.js",
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [],
        unloadMissing: true,
        unloadMissingEndpointIds: ["device-a"],
      }),
    ).resolves.toEqual({
      registered: [],
      unloaded: ["@remote/volatile"],
      skipped: [],
      trustDecisions: [],
    });

    expect(runtime.plugins).toEqual([]);
    expect(runtime.actions).toEqual([]);
    expect(runtime.providers).toEqual([]);
    expect(runtime.routes).toEqual([]);
    expect(getView("volatile.view")).toBeUndefined();
  });

  it("scopes stale unloads to the selected endpoint so another device remains loaded", async () => {
    const deviceAModule: RemotePluginModuleManifest = {
      id: "device-a-tools",
      name: "@remote/device-a",
      capabilityEndpointId: "device-a",
      actions: [
        {
          name: "DEVICE_A_ACTION",
          description: "Action owned by device A.",
        },
      ],
      routes: [
        {
          method: "POST",
          path: "/device-a/route",
          public: true,
        },
      ],
      views: [
        {
          id: "device-a.view",
          label: "Device A View",
          bundleUrl: "https://device-a.example/view.js",
        },
      ],
    };
    const deviceBModule: RemotePluginModuleManifest = {
      id: "device-b-tools",
      name: "@remote/device-b",
      capabilityEndpointId: "device-b",
      actions: [
        {
          name: "DEVICE_B_ACTION",
          description: "Action owned by device B.",
        },
      ],
      routes: [
        {
          method: "POST",
          path: "/device-b/route",
          public: true,
        },
      ],
      views: [
        {
          id: "device-b.view",
          label: "Device B View",
          bundleUrl: "https://device-b.example/view.js",
        },
      ],
    };
    const runtime = makeLifecycleRuntime(makeRouter());

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [deviceAModule, deviceBModule],
        trustPolicy: {
          allowedEndpointIds: ["device-a", "device-b"],
          allowedModuleIds: ["device-a-tools", "device-b-tools"],
          requireEndpointId: true,
        },
      }),
    ).resolves.toMatchObject({
      registered: [
        expect.objectContaining({ name: "@remote/device-a" }),
        expect.objectContaining({ name: "@remote/device-b" }),
      ],
      unloaded: [],
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [],
        unloadMissing: true,
        unloadMissingEndpointIds: ["device-a"],
      }),
    ).resolves.toEqual({
      registered: [],
      unloaded: ["@remote/device-a"],
      skipped: [],
      trustDecisions: [],
    });

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/device-b",
    ]);
    expect(runtime.actions.map((action) => action.name)).toEqual([
      "DEVICE_B_ACTION",
    ]);
    expect(runtime.routes.map((route) => route.path)).toEqual([
      "/device-b/route",
    ]);
    expect(getView("device-a.view")).toBeUndefined();
    expect(getView("device-b.view")).toMatchObject({
      pluginName: "@remote/device-b",
      bundleUrl: "https://device-b.example/view.js",
    });
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
      trustDecisions: [],
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

    await expect(
      bootstrapRemoteCapabilityPlugins(runtime),
    ).resolves.toMatchObject({
      registered: [expect.objectContaining({ name: "@remote/demo" })],
      unloaded: [],
      skipped: [],
      trustDecisions: [
        expect.objectContaining({
          moduleId: "remote-demo",
          endpointId: "remote-1",
          trusted: true,
        }),
      ],
    });
    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/demo",
    ]);
  });

  it("bootstraps from persisted config.env endpoint JSON after restart", async () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
    const previousUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;
    const previousAllowedModules =
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
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
      await persistConfigEnv(
        "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES",
        JSON.stringify({ "persisted-device": ["remote-demo"] }),
      );

      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      loadElizaConfig();

      expect(process.env.ELIZA_CAPABILITY_ROUTER_ENABLED).toBe("true");
      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toContain(
        "persisted-token",
      );
      expect(process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toContain(
        "remote-demo",
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

      await expect(
        bootstrapRemoteCapabilityPlugins(runtime),
      ).resolves.toMatchObject({
        registered: [expect.objectContaining({ name: "@remote/demo" })],
        unloaded: [],
        skipped: [],
        trustDecisions: [
          expect.objectContaining({
            moduleId: "remote-demo",
            endpointId: "persisted-device",
            trusted: true,
          }),
        ],
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
      if (previousAllowedModules === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
          previousAllowedModules;
      }
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("bootstraps after a product connect route persists endpoint config", async () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
    const previousUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;
    const previousAllowedModules =
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
    const stateDir = await mkdtemp(
      join(tmpdir(), "remote-capability-product-restart-"),
    );
    const httpCalls: Array<{ url: string; authorization: string | null }> = [];

    try {
      process.env.ELIZA_STATE_DIR = stateDir;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;

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

      const routeRuntime = makeProductConnectRuntime();
      const savedConfig: Record<string, unknown> = {};
      const json = vi.fn();
      const error = vi.fn();
      await expect(
        handleRemoteCapabilityRoutes({
          req: {} as never,
          res: {} as never,
          method: "POST",
          pathname: "/api/capability-router/connect",
          runtime: routeRuntime,
          config: savedConfig,
          saveConfig: (config) => Object.assign(savedConfig, config),
          persistConfigEnv,
          readJsonBody: vi.fn().mockResolvedValue({
            endpoint: {
              id: "product-device",
              baseUrl: "https://product-device.example",
              token: "product-token",
            },
            allowedModuleIds: ["remote-demo"],
            persist: true,
            unloadMissing: false,
          }),
          json,
          error,
        }),
      ).resolves.toBe(true);

      expect(error).not.toHaveBeenCalled();
      expect(json.mock.calls[0]?.[1]).toMatchObject({
        success: true,
        mode: "endpoint",
        persisted: true,
        endpoint: {
          id: "product-device",
          baseUrl: "https://product-device.example",
          hasToken: true,
        },
      });
      expect(JSON.stringify(savedConfig)).not.toContain("product-token");
      const trustAudit = JSON.parse(
        (
          savedConfig.env as {
            vars: Record<string, string>;
          }
        ).vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT,
      );
      expect(trustAudit).toEqual([
        expect.objectContaining({
          mode: "endpoint",
          provider: "direct",
          endpoint: {
            id: "product-device",
            baseUrl: "https://product-device.example",
            hasToken: true,
          },
          allowedModuleIds: ["remote-demo"],
          registered: ["@remote/demo"],
          skipped: [],
          unloaded: [],
          trustDecisions: [
            expect.objectContaining({
              endpointId: "product-device",
              moduleId: "remote-demo",
              pluginName: "@remote/demo",
              trusted: true,
              reason: "allowed",
            }),
          ],
        }),
      ]);
      expect(JSON.stringify(trustAudit)).not.toContain("product-token");

      saveElizaConfig(savedConfig as never);
      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      loadElizaConfig();

      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toContain(
        "product-token",
      );
      expect(process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
        JSON.stringify({ "product-device": ["remote-demo"] }),
      );

      const restartRuntime = makeProductConnectRuntime();
      await expect(
        bootstrapRemoteCapabilityPlugins(restartRuntime),
      ).resolves.toMatchObject({
        registered: [expect.objectContaining({ name: "@remote/demo" })],
        unloaded: [],
        skipped: [],
        trustDecisions: [
          expect.objectContaining({
            moduleId: "remote-demo",
            endpointId: "product-device",
            trusted: true,
            reason: "allowed",
          }),
        ],
      });
      expect(restartRuntime.plugins.map((plugin) => plugin.name)).toEqual([
        "@remote/demo",
      ]);
      expect(httpCalls).toContainEqual({
        url: "https://product-device.example/v1/capabilities/invoke",
        authorization: "Bearer product-token",
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
      if (previousAllowedModules === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
          previousAllowedModules;
      }
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("reopens a persisted Cloud-provisioned remote view after restart", async () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
    const previousUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;
    const previousAllowedModules =
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
    const previousTrustAudit = process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;
    const stateDir = await mkdtemp(
      join(tmpdir(), "remote-capability-cloud-view-restart-"),
    );
    const cloudModule: RemotePluginModuleManifest = {
      id: "cloud-product-plugin",
      name: "@remote/cloud-product",
      capabilityEndpointId: "cloud-product",
      views: [
        {
          id: "cloud.restart.view",
          label: "Cloud Restart View",
          bundlePath: "/assets/cloud-view.js",
        },
      ],
    };
    const httpCalls: Array<{
      url: string;
      authorization: string | null;
      method: string;
    }> = [];

    try {
      process.env.ELIZA_STATE_DIR = stateDir;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      delete process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;

      const routeRuntime = makeProductConnectRuntime();
      const savedConfig: Record<string, unknown> = {};
      const json = vi.fn();
      const error = vi.fn();
      await expect(
        handleRemoteCapabilityRoutes({
          req: {} as never,
          res: {} as never,
          method: "POST",
          pathname: "/api/capability-router/connect",
          runtime: routeRuntime,
          config: savedConfig,
          saveConfig: (config) => Object.assign(savedConfig, config),
          persistConfigEnv,
          connectCloudSandbox: vi.fn().mockResolvedValue({
            providerId: "cloud",
            agentId: "cloud-agent-1",
            jobId: "cloud-job-1",
            endpoint: {
              id: "cloud-product",
              baseUrl: "https://cloud-product.example",
              token: "cloud-product-token",
            },
            allowedModuleIds: ["cloud-product-plugin"],
            sync: {
              registered: [
                createRemoteCapabilityPlugin({
                  ...cloudModule,
                  capabilityEndpointId: "cloud-product",
                }),
              ],
              unloaded: [],
              skipped: [],
              trustDecisions: [
                {
                  endpointId: "cloud-product",
                  moduleId: "cloud-product-plugin",
                  pluginName: "@remote/cloud-product",
                  trusted: true,
                  reason: "allowed",
                },
              ],
            },
          }),
          readJsonBody: vi.fn().mockResolvedValue({
            cloud: {
              cloudApiBase: "https://cloud.example",
              authToken: "cloud-auth-token",
              name: "Cloud Product View",
              endpointId: "cloud-product",
              allowedModuleIds: ["cloud-product-plugin"],
            },
            persist: true,
          }),
          json,
          error,
        }),
      ).resolves.toBe(true);

      expect(error).not.toHaveBeenCalled();
      expect(json.mock.calls[0]?.[1]).toMatchObject({
        success: true,
        mode: "cloud",
        agentId: "cloud-agent-1",
        jobId: "cloud-job-1",
        endpoint: {
          id: "cloud-product",
          baseUrl: "https://cloud-product.example",
          hasToken: true,
        },
        persisted: true,
      });
      expect(JSON.stringify(savedConfig)).not.toContain("cloud-product-token");
      expect(
        (
          savedConfig.env as {
            vars: Record<string, string>;
          }
        ).vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT,
      ).toContain("cloud-product-plugin");

      saveElizaConfig(savedConfig as never);
      delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
      delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
      delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      delete process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;
      loadElizaConfig();

      globalThis.fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          httpCalls.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
            method: request.method,
          });
          if (request.method === "POST") {
            const body = await request.json();
            if (isInvokeBody(body, "plugin.modules.list")) {
              return jsonResponse({
                ok: true,
                result: { modules: [cloudModule] },
              });
            }
            if (isInvokeBody(body, "plugin.asset.get")) {
              return jsonResponse({
                ok: true,
                result: {
                  path: "/assets/cloud-view.js",
                  contentType: "text/javascript",
                  bodyBase64: Buffer.from(
                    "export const cloudRestartView = true;",
                  ).toString("base64"),
                },
              });
            }
          }
          return jsonResponse({
            ok: false,
            error: { message: `unexpected request ${request.url}` },
          });
        },
      ) as unknown as typeof fetch;

      const restartRuntime = makeProductConnectRuntime();
      await expect(
        bootstrapRemoteCapabilityPlugins(restartRuntime),
      ).resolves.toMatchObject({
        registered: [
          expect.objectContaining({ name: "@remote/cloud-product" }),
        ],
        unloaded: [],
        skipped: [],
        trustDecisions: [
          expect.objectContaining({
            endpointId: "cloud-product",
            moduleId: "cloud-product-plugin",
            trusted: true,
          }),
        ],
      });

      const reopenedView = getView("cloud.restart.view");
      expect(reopenedView).toMatchObject({
        pluginName: "@remote/cloud-product",
        bundleUrl:
          "/api/capability-router/assets/cloud-product/cloud-product-plugin/assets/cloud-view.js",
      });
      const writeHead = vi.fn();
      const end = vi.fn();
      await expect(
        handleRemoteCapabilityRoutes({
          req: { headers: {} } as never,
          res: { writeHead, end } as never,
          method: "GET",
          pathname:
            "/api/capability-router/assets/cloud-product/cloud-product-plugin/assets/cloud-view.js",
          runtime: restartRuntime,
          readJsonBody: vi.fn(),
          json: vi.fn(),
          error: vi.fn(),
        }),
      ).resolves.toBe(true);

      expect(writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/javascript",
          "Content-Length": Buffer.byteLength(
            "export const cloudRestartView = true;",
          ),
        }),
      );
      expect(end).toHaveBeenCalledWith(
        Buffer.from("export const cloudRestartView = true;"),
      );
      expect(httpCalls).toContainEqual({
        url: "https://cloud-product.example/v1/capabilities/invoke",
        authorization: "Bearer cloud-product-token",
        method: "POST",
      });
      expect(httpCalls).toContainEqual({
        url: "https://cloud-product.example/v1/capabilities/invoke",
        authorization: "Bearer cloud-product-token",
        method: "POST",
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
      if (previousAllowedModules === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
          previousAllowedModules;
      }
      if (previousTrustAudit === undefined) {
        delete process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;
      } else {
        process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT = previousTrustAudit;
      }
      unregisterPluginViews("@remote/cloud-product");
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

    await expect(
      bootstrapRemoteCapabilityPlugins(runtime),
    ).resolves.toMatchObject({
      registered: expect.arrayContaining([
        expect.objectContaining({ name: "@remote/device-tools" }),
        expect.objectContaining({ name: "@remote/cloud-tools" }),
      ]),
      unloaded: [],
      skipped: [],
      trustDecisions: expect.arrayContaining([
        expect.objectContaining({
          moduleId: "device-tools",
          endpointId: "device",
          trusted: true,
        }),
        expect.objectContaining({
          moduleId: "cloud-tools",
          endpointId: "cloud",
          trusted: true,
        }),
      ]),
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
    expect(runtime.plugins[0]?.config).toMatchObject({
      remoteCapabilityModuleId: "device-tools",
      remoteCapabilityEndpointId: "device",
    });
    expect(runtime.plugins[1]?.config).toMatchObject({
      remoteCapabilityModuleId: "cloud-tools",
      remoteCapabilityEndpointId: "cloud",
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

    expect(httpCalls).toEqual([
      expect.objectContaining({
        url: "https://device.example/v1/capabilities/invoke",
        body: expect.objectContaining({
          method: "plugin.modules.list",
        }),
      }),
      expect.objectContaining({
        url: "https://cloud.example/v1/capabilities/invoke",
        body: expect.objectContaining({
          method: "plugin.modules.list",
        }),
      }),
      expect.objectContaining({
        url: "https://cloud.example/v1/capabilities/invoke",
        body: expect.objectContaining({
          method: "plugin.action.invoke",
          params: expect.objectContaining({
            endpointId: "cloud",
            moduleId: "cloud-tools",
            action: "CLOUD_SUMMARIZE",
          }),
        }),
      }),
      expect.objectContaining({
        url: "https://device.example/v1/capabilities/invoke",
        body: expect.objectContaining({
          method: "plugin.provider.get",
          params: expect.objectContaining({
            endpointId: "device",
            moduleId: "device-tools",
            provider: "DEVICE_CONTEXT",
          }),
        }),
      }),
      expect.objectContaining({
        url: "https://device.example/v1/capabilities/invoke",
        body: expect.objectContaining({
          method: "plugin.route.call",
          params: expect.objectContaining({
            endpointId: "device",
            moduleId: "device-tools",
            path: "/device/ping",
          }),
        }),
      }),
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

      await expect(
        bootstrapRemoteCapabilityPlugins(runtime),
      ).resolves.toMatchObject({
        registered: [
          expect.objectContaining({ name: "@remote/localhost-tools" }),
        ],
        unloaded: [],
        skipped: [],
        trustDecisions: [
          expect.objectContaining({
            moduleId: "localhost-tools",
            endpointId: "primary",
            trusted: true,
          }),
        ],
      });
      const expectedBundleUrl =
        "/api/capability-router/assets/primary/localhost-tools/assets/localhost-panel.js";
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
      const remoteBundleUrl = `${server.baseUrl}/v1/capabilities/assets/localhost-tools/assets/localhost-panel.js`;
      const bundleResponse = await fetch(remoteBundleUrl, {
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

  esbuildSmoke(
    "builds a remote plugin from source and loads it only through the capability protocol",
    async () => {
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
      const buildResult = await buildRemoteViewFixtures({
        entryPoints: [viewSource],
        outfile: builtBundlePath,
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
            evaluators: [{
              name: "BUILT_SOURCE_EVALUATOR",
              description: "Built source evaluator.",
              prompt: "Built source evaluator prompt.",
              schema: { type: "object" },
              hasPrepare: true,
              hasProcessor: true,
            }],
            responseHandlerEvaluators: [{
              name: "BUILT_SOURCE_RESPONSE_EVALUATOR",
              description: "Built source response evaluator.",
            }],
            responseHandlerFieldEvaluators: [{
              name: "BUILT_SOURCE_FIELD_EVALUATOR",
              description: "Built source field evaluator.",
              schema: { type: "object" },
              hasParse: true,
              hasHandle: true,
            }],
            lifecycle: { hooks: ["init", "applyConfig"] },
            events: [{ eventName: "built.source.event" }],
            models: [{ modelType: "BUILT_SOURCE_TEXT", priority: 20 }],
            services: [{
              serviceType: "built_source_service",
              capabilityDescription: "Built source service.",
              methods: ["lookup"],
            }],
            appBridge: { hooks: ["prepareLaunch"] },
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
      invokeModel: async ({ params }) => ({
        result: {
          text: "built source model",
          params,
        },
      }),
      shouldRunEvaluator: async () => ({ shouldRun: true }),
      prepareEvaluator: async () => ({ prepared: { sourceBuilt: true } }),
      promptEvaluator: async () => ({ prompt: "Built source evaluator prompt." }),
      processEvaluator: async ({ output }) => ({
        result: {
          success: true,
          text: "built source evaluator processed",
          output,
        },
      }),
      shouldRunResponseHandlerEvaluator: async () => ({ shouldRun: true }),
      evaluateResponseHandlerEvaluator: async () => ({
        patch: { reply: "built source response patch" },
      }),
      shouldRunResponseHandlerFieldEvaluator: async () => ({ shouldRun: true }),
      parseResponseHandlerFieldEvaluator: async ({ value }) => ({
        value: { parsed: value },
      }),
      handleResponseHandlerFieldEvaluator: async () => ({
        effect: {
          patch: { builtSourceFieldHandled: true },
          debug: ["built source field handled"],
        },
      }),
      callLifecycle: async () => ({ ok: true }),
      handleEvent: async () => ({ handled: true }),
      callService: async ({ args }) => ({
        result: {
          text: "built source service",
          args,
        },
      }),
      callAppBridge: async () => ({
        result: { launchUrl: "https://built-source.example/launch" },
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

        await expect(
          bootstrapRemoteCapabilityPlugins(runtime),
        ).resolves.toMatchObject({
          registered: [
            expect.objectContaining({ name: "@remote/built-source" }),
          ],
          unloaded: [],
          skipped: [],
          trustDecisions: [
            expect.objectContaining({
              moduleId: "built-source-plugin",
              endpointId: "primary",
              trusted: true,
            }),
          ],
        });

        const expectedBundleUrl =
          "/api/capability-router/assets/primary/built-source-plugin/assets/remote-view.js";
        expect(getView("built-source.view")).toMatchObject({
          id: "built-source.view",
          pluginName: "@remote/built-source",
          bundleUrl: expectedBundleUrl,
          available: true,
        });

        const remoteBundleUrl = `${server.baseUrl}/v1/capabilities/assets/built-source-plugin/assets/remote-view.js`;
        const bundleResponse = await fetch(remoteBundleUrl, {
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
        const plugin = runtime.plugins.find(
          (candidate) => candidate.name === "@remote/built-source",
        );
        expect(plugin).toBeDefined();
        const evaluatorContext = {
          runtime,
          message: {
            id: "22222222-2222-2222-2222-222222222222" as UUID,
            entityId: "33333333-3333-3333-3333-333333333333" as UUID,
            roomId: "44444444-4444-4444-4444-444444444444" as UUID,
            content: { text: "evaluate built source" },
          },
          state: { values: {}, data: {}, text: "state" },
          options: {},
        };
        await expect(
          plugin?.evaluators?.[0]?.shouldRun(evaluatorContext),
        ).resolves.toBe(true);
        await expect(
          plugin?.evaluators?.[0]?.prepare?.(evaluatorContext),
        ).resolves.toEqual({ sourceBuilt: true });
        expect(
          plugin?.evaluators?.[0]?.prompt({
            ...evaluatorContext,
            prepared: { sourceBuilt: true },
          } as never),
        ).toBe("Built source evaluator prompt.");
        await expect(
          plugin?.evaluators?.[0]?.processors?.[0]?.process({
            ...evaluatorContext,
            prepared: { sourceBuilt: true },
            output: { ok: true },
            evaluatorName: "BUILT_SOURCE_EVALUATOR",
          } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "built source evaluator processed",
        });
        const responseHandlerContext = {
          runtime,
          message: evaluatorContext.message,
          state: evaluatorContext.state,
          messageHandler: {
            processMessage: "RESPOND",
            thought: "built source",
            plan: { contexts: [], candidateActions: [] },
          },
          availableContexts: [],
        };
        await expect(
          plugin?.responseHandlerEvaluators?.[0]?.shouldRun(
            responseHandlerContext as never,
          ),
        ).resolves.toBe(true);
        await expect(
          plugin?.responseHandlerEvaluators?.[0]?.evaluate(
            responseHandlerContext as never,
          ),
        ).resolves.toEqual({ reply: "built source response patch" });
        const responseHandlerFieldContext = {
          runtime,
          message: evaluatorContext.message,
          state: evaluatorContext.state,
          senderRole: "OWNER",
          turnSignal: new AbortController().signal,
        };
        await expect(
          plugin?.responseHandlerFieldEvaluators?.[0]?.shouldRun?.(
            responseHandlerFieldContext as never,
          ),
        ).resolves.toBe(true);
        await expect(
          plugin?.responseHandlerFieldEvaluators?.[0]?.parse?.(
            { value: true },
            responseHandlerFieldContext as never,
          ),
        ).resolves.toEqual({ parsed: { value: true } });
        const fieldEffect =
          await plugin?.responseHandlerFieldEvaluators?.[0]?.handle?.({
            ...responseHandlerFieldContext,
            value: { value: true },
            parsed: {
              shouldRespond: "RESPOND",
              contexts: [],
              intents: [],
              candidateActionNames: [],
              replyText: "",
              facts: [],
              relationships: [],
              addressedTo: [],
            },
          } as never);
        const mutableResult = {
          shouldRespond: "RESPOND" as const,
          contexts: [],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        };
        fieldEffect?.mutateResult?.(mutableResult);
        expect(mutableResult).toMatchObject({ builtSourceFieldHandled: true });
        expect(fieldEffect?.debug).toEqual(["built source field handled"]);
        await expect(
          (
            plugin?.events as Record<
              string,
              Array<(payload: unknown) => Promise<void> | void>
            >
          )?.["built.source.event"]?.[0]?.({
            runtime,
            payload: true,
          } as never),
        ).resolves.toBeUndefined();
        const builtSourceService = runtime.getService(
          "built_source_service",
        ) as unknown as {
          lookup: (...args: unknown[]) => Promise<unknown>;
        } | null;
        await expect(
          builtSourceService?.lookup({ query: "service" }),
        ).resolves.toEqual({
          text: "built source service",
          args: [{ query: "service" }],
        });
        await expect(
          plugin?.appBridge?.prepareLaunch?.({
            runtime,
            appId: "built-source",
          } as never),
        ).resolves.toEqual({
          launchUrl: "https://built-source.example/launch",
        });
        const modelHandlers = (
          runtime as unknown as {
            models: Map<
              string,
              Array<{
                handler: (
                  runtime: IAgentRuntime,
                  params: unknown,
                ) => Promise<unknown>;
              }>
            >;
          }
        ).models;
        await expect(
          modelHandlers.get("BUILT_SOURCE_TEXT")?.[0]?.handler(runtime, {
            prompt: "hello model",
          }),
        ).resolves.toEqual({
          text: "built source model",
          params: { prompt: "hello model" },
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
    },
  );

  esbuildSmoke(
    "loads a built remote plugin from a separate capability server process",
    async () => {
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
      const buildResult = await buildRemoteViewFixtures({
        entryPoints: [viewSource],
        outfile: builtBundlePath,
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

        await expect(
          bootstrapRemoteCapabilityPlugins(runtime),
        ).resolves.toMatchObject({
          registered: [
            expect.objectContaining({ name: "@remote/process-plugin" }),
          ],
          unloaded: [],
          skipped: [],
          trustDecisions: [
            expect.objectContaining({
              moduleId: "process-plugin",
              endpointId: "primary",
              trusted: true,
            }),
          ],
        });

        const bundleUrl =
          "/api/capability-router/assets/primary/process-plugin/assets/process-view.js";
        expect(getView("process.view")).toMatchObject({
          id: "process.view",
          pluginName: "@remote/process-plugin",
          bundleUrl,
          available: true,
        });
        const remoteBundleUrl = `${baseUrl}/v1/capabilities/assets/process-plugin/assets/process-view.js`;
        const bundleResponse = await fetch(remoteBundleUrl, {
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
    },
  );

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
      const toolsViewSource = join(srcDir, "docker-tools-view.ts");
      await writeFile(
        viewSource,
        [
          "export const marker = 'docker-built-remote-view';",
          "export const isolation = 'docker';",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        toolsViewSource,
        [
          "export const marker = 'docker-tools-built-remote-view';",
          "export const isolation = 'docker';",
          "export const module = 'tools';",
          "",
        ].join("\n"),
        "utf8",
      );
      const buildResult = await buildRemoteViewFixtures({
        entryPoints: [viewSource, toolsViewSource],
        outdir: distDir,
      });
      expect(buildResult.errors).toHaveLength(0);

      await writeFile(
        join(workspace, "server.mjs"),
        `
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const token = process.env.REMOTE_CAPABILITY_TOKEN;
const port = Number(process.env.PORT || 8080);
const moduleLabel = (moduleId) => moduleId === "docker-tools-plugin" ? "tools" : "primary";

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
    if (req.method === "GET" && url.pathname === "/v1/capabilities/assets/docker-tools-plugin/assets/docker-tools-view.js") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/javascript");
      res.end(readFileSync("/app/dist/docker-tools-view.js"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/capabilities/invoke") {
      const body = await readBody(req);
      if (body.method === "plugin.modules.list") {
        return json(res, 200, { ok: true, result: { modules: [
          {
            id: "docker-plugin",
            name: "@remote/docker-plugin",
            description: "Remote plugin served from a Docker container.",
            actions: [{ name: "DOCKER_ACTION", description: "Run Docker action." }],
            providers: [{ name: "DOCKER_CONTEXT", description: "Docker provider." }],
            evaluators: [{ name: "DOCKER_EVALUATOR", description: "Docker evaluator.", prompt: "Docker evaluator prompt.", schema: { type: "object" }, hasPrepare: true, hasProcessor: true }],
            responseHandlerEvaluators: [{ name: "DOCKER_RESPONSE_EVALUATOR", description: "Docker response evaluator." }],
            responseHandlerFieldEvaluators: [{ name: "DOCKER_FIELD_EVALUATOR", description: "Docker field evaluator.", schema: { type: "object" }, hasParse: true, hasHandle: true }],
            lifecycle: { hooks: ["init", "applyConfig"] },
            events: [{ eventName: "docker.event" }],
            models: [{ modelType: "DOCKER_TEXT", priority: 10 }],
            services: [{ serviceType: "docker_service", capabilityDescription: "Docker service.", methods: ["lookup"] }],
            appBridge: { hooks: ["prepareLaunch"] },
            routes: [{ method: "POST", path: "/docker/route", public: true, name: "docker-route" }],
            views: [{ id: "docker.view", label: "Docker View", bundlePath: "/assets/docker-view.js" }],
          },
          {
            id: "docker-tools-plugin",
            name: "@remote/docker-tools-plugin",
            description: "Second remote plugin served from the same Docker container.",
            actions: [{ name: "DOCKER_TOOLS_ACTION", description: "Run Docker tools action." }],
            providers: [{ name: "DOCKER_TOOLS_CONTEXT", description: "Docker tools provider." }],
            evaluators: [{ name: "DOCKER_TOOLS_EVALUATOR", description: "Docker tools evaluator.", prompt: "Docker tools evaluator prompt.", schema: { type: "object" }, hasPrepare: true, hasProcessor: true }],
            responseHandlerEvaluators: [{ name: "DOCKER_TOOLS_RESPONSE_EVALUATOR", description: "Docker tools response evaluator." }],
            responseHandlerFieldEvaluators: [{ name: "DOCKER_TOOLS_FIELD_EVALUATOR", description: "Docker tools field evaluator.", schema: { type: "object" }, hasParse: true, hasHandle: true }],
            lifecycle: { hooks: ["init", "applyConfig"] },
            events: [{ eventName: "docker.tools.event" }],
            models: [{ modelType: "DOCKER_TOOLS_TEXT", priority: 11 }],
            services: [{ serviceType: "docker_tools_service", capabilityDescription: "Docker tools service.", methods: ["lookup"] }],
            appBridge: { hooks: ["prepareLaunch"] },
            routes: [{ method: "POST", path: "/docker-tools/route", public: true, name: "docker-tools-route" }],
            views: [{ id: "docker.tools.view", label: "Docker Tools View", bundlePath: "/assets/docker-tools-view.js" }],
          },
        ] } });
      }
      if (body.method === "plugin.action.invoke") {
        if (body.params?.moduleId === "docker-tools-plugin") {
          return json(res, 200, { ok: true, result: { text: "docker tools action", data: { container: true, module: "tools" } } });
        }
        return json(res, 200, { ok: true, result: { text: "docker action", data: { container: true, module: "primary" } } });
      }
      if (body.method === "plugin.provider.get") {
        if (body.params?.moduleId === "docker-tools-plugin") {
          return json(res, 200, { ok: true, result: { text: "docker tools provider", values: { isolated: "container", module: "tools" } } });
        }
        return json(res, 200, { ok: true, result: { text: "docker provider", values: { isolated: "container", module: "primary" } } });
      }
      if (body.method === "plugin.route.call") {
        if (body.params?.moduleId === "docker-tools-plugin") {
          return json(res, 200, { ok: true, result: { status: 210, headers: { "x-docker-tools-plugin": "yes" }, body: { dockerToolsRoute: true, body: body.params?.body } } });
        }
        return json(res, 200, { ok: true, result: { status: 209, headers: { "x-docker-plugin": "yes" }, body: { dockerRoute: true, body: body.params?.body } } });
      }
      if (body.method === "plugin.model.invoke") {
        if (body.params?.moduleId === "docker-tools-plugin") {
          return json(res, 200, { ok: true, result: { result: { text: "docker tools model", module: "tools", params: body.params?.params } } });
        }
        return json(res, 200, { ok: true, result: { result: { text: "docker model", module: "primary", params: body.params?.params } } });
      }
      if (body.method === "plugin.evaluator.shouldRun") {
        return json(res, 200, { ok: true, result: { shouldRun: true } });
      }
      if (body.method === "plugin.evaluator.prepare") {
        return json(res, 200, { ok: true, result: { prepared: { module: moduleLabel(body.params?.moduleId) } } });
      }
      if (body.method === "plugin.evaluator.prompt") {
        return json(res, 200, { ok: true, result: { prompt: \`docker \${moduleLabel(body.params?.moduleId)} evaluator prompt\` } });
      }
      if (body.method === "plugin.evaluator.process") {
        return json(res, 200, { ok: true, result: { result: { success: true, text: \`docker \${moduleLabel(body.params?.moduleId)} evaluator processed\` } } });
      }
      if (body.method === "plugin.responseHandlerEvaluator.shouldRun") {
        return json(res, 200, { ok: true, result: { shouldRun: true } });
      }
      if (body.method === "plugin.responseHandlerEvaluator.evaluate") {
        return json(res, 200, { ok: true, result: { patch: { reply: \`docker \${moduleLabel(body.params?.moduleId)} response patch\` } } });
      }
      if (body.method === "plugin.responseHandlerFieldEvaluator.shouldRun") {
        return json(res, 200, { ok: true, result: { shouldRun: true } });
      }
      if (body.method === "plugin.responseHandlerFieldEvaluator.parse") {
        return json(res, 200, { ok: true, result: { value: { parsed: body.params?.value, module: moduleLabel(body.params?.moduleId) } } });
      }
      if (body.method === "plugin.responseHandlerFieldEvaluator.handle") {
        return json(res, 200, { ok: true, result: { effect: { patch: { dockerFieldHandled: moduleLabel(body.params?.moduleId) }, debug: [\`docker \${moduleLabel(body.params?.moduleId)} field handled\`] } } });
      }
      if (body.method === "plugin.lifecycle.call") {
        return json(res, 200, { ok: true, result: { ok: true } });
      }
      if (body.method === "plugin.event.handle") {
        return json(res, 200, { ok: true, result: { handled: true } });
      }
      if (body.method === "plugin.service.call") {
        return json(res, 200, { ok: true, result: { result: { text: \`docker \${moduleLabel(body.params?.moduleId)} service\`, args: body.params?.args ?? [] } } });
      }
      if (body.method === "plugin.appBridge.call") {
        return json(res, 200, { ok: true, result: { result: { launchUrl: \`https://docker.example/\${moduleLabel(body.params?.moduleId)}\` } } });
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
          "COPY dist/docker-tools-view.js /app/dist/docker-tools-view.js",
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
          bootstrapRemoteCapabilityPlugins(runtime, {
            trustPolicy: {
              allowedEndpointIds: ["primary"],
              allowedModuleIds: ["docker-plugin", "docker-tools-plugin"],
              requireEndpointId: true,
            },
          }),
        ).resolves.toEqual({
          registered: [
            expect.objectContaining({ name: "@remote/docker-plugin" }),
            expect.objectContaining({ name: "@remote/docker-tools-plugin" }),
          ],
          unloaded: [],
          skipped: [],
          trustDecisions: [
            {
              moduleId: "docker-plugin",
              pluginName: "@remote/docker-plugin",
              endpointId: "primary",
              trusted: true,
              reason: "allowed",
            },
            {
              moduleId: "docker-tools-plugin",
              pluginName: "@remote/docker-tools-plugin",
              endpointId: "primary",
              trusted: true,
              reason: "allowed",
            },
          ],
        });

        const bundleUrl =
          "/api/capability-router/assets/primary/docker-plugin/assets/docker-view.js";
        expect(getView("docker.view")).toMatchObject({
          id: "docker.view",
          pluginName: "@remote/docker-plugin",
          bundleUrl,
          available: true,
        });
        expect(getView("docker.tools.view")).toMatchObject({
          id: "docker.tools.view",
          pluginName: "@remote/docker-tools-plugin",
          bundleUrl:
            "/api/capability-router/assets/primary/docker-tools-plugin/assets/docker-tools-view.js",
          available: true,
        });
        const remoteBundleUrl = `${baseUrl}/v1/capabilities/assets/docker-plugin/assets/docker-view.js`;
        const bundleResponse = await fetch(remoteBundleUrl, {
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
        const toolsBundleResponse = await fetch(
          `${baseUrl}/v1/capabilities/assets/docker-tools-plugin/assets/docker-tools-view.js`,
          {
            headers: { authorization: "Bearer docker-token" },
          },
        );
        expect(toolsBundleResponse.status).toBe(200);
        const toolsBundleSource = await toolsBundleResponse.text();
        await expect(
          import(
            `data:text/javascript;base64,${Buffer.from(
              toolsBundleSource,
            ).toString("base64")}`
          ),
        ).resolves.toMatchObject({
          marker: "docker-tools-built-remote-view",
          isolation: "docker",
          module: "tools",
        });
        await expect(
          runtime.actions[0]?.handler(runtime, { content: {} } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "docker action",
          data: { container: true, module: "primary" },
        });
        await expect(
          runtime.actions[1]?.handler(runtime, { content: {} } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "docker tools action",
          data: { container: true, module: "tools" },
        });
        await expect(
          runtime.providers[0]?.get(runtime, {} as never, {} as never),
        ).resolves.toMatchObject({
          text: "docker provider",
          values: { isolated: "container", module: "primary" },
        });
        await expect(
          runtime.providers[1]?.get(runtime, {} as never, {} as never),
        ).resolves.toMatchObject({
          text: "docker tools provider",
          values: { isolated: "container", module: "tools" },
        });
        const dockerPlugin = runtime.plugins.find(
          (plugin) => plugin.name === "@remote/docker-plugin",
        );
        const dockerToolsPlugin = runtime.plugins.find(
          (plugin) => plugin.name === "@remote/docker-tools-plugin",
        );
        expect(dockerPlugin).toBeDefined();
        expect(dockerToolsPlugin).toBeDefined();
        const dockerEvaluatorContext = {
          runtime,
          message: {
            id: "22222222-2222-2222-2222-222222222222" as UUID,
            entityId: "33333333-3333-3333-3333-333333333333" as UUID,
            roomId: "44444444-4444-4444-4444-444444444444" as UUID,
            content: { text: "docker evaluator" },
          },
          state: { values: {}, data: {}, text: "state" },
          options: {},
        };
        await expect(
          dockerPlugin?.evaluators?.[0]?.shouldRun(dockerEvaluatorContext),
        ).resolves.toBe(true);
        await expect(
          dockerToolsPlugin?.evaluators?.[0]?.shouldRun(dockerEvaluatorContext),
        ).resolves.toBe(true);
        await expect(
          dockerPlugin?.evaluators?.[0]?.prepare?.(dockerEvaluatorContext),
        ).resolves.toEqual({ module: "primary" });
        await expect(
          dockerToolsPlugin?.evaluators?.[0]?.prepare?.(dockerEvaluatorContext),
        ).resolves.toEqual({ module: "tools" });
        await expect(
          dockerPlugin?.evaluators?.[0]?.processors?.[0]?.process({
            ...dockerEvaluatorContext,
            prepared: { module: "primary" },
            output: { ok: true },
            evaluatorName: "DOCKER_EVALUATOR",
          } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "docker primary evaluator processed",
        });
        await expect(
          dockerToolsPlugin?.evaluators?.[0]?.processors?.[0]?.process({
            ...dockerEvaluatorContext,
            prepared: { module: "tools" },
            output: { ok: true },
            evaluatorName: "DOCKER_TOOLS_EVALUATOR",
          } as never),
        ).resolves.toMatchObject({
          success: true,
          text: "docker tools evaluator processed",
        });
        const dockerResponseContext = {
          runtime,
          message: dockerEvaluatorContext.message,
          state: dockerEvaluatorContext.state,
          messageHandler: {
            processMessage: "RESPOND",
            thought: "docker",
            plan: { contexts: [], candidateActions: [] },
          },
          availableContexts: [],
        };
        await expect(
          dockerPlugin?.responseHandlerEvaluators?.[0]?.evaluate(
            dockerResponseContext as never,
          ),
        ).resolves.toEqual({ reply: "docker primary response patch" });
        await expect(
          dockerToolsPlugin?.responseHandlerEvaluators?.[0]?.evaluate(
            dockerResponseContext as never,
          ),
        ).resolves.toEqual({ reply: "docker tools response patch" });
        const dockerFieldContext = {
          runtime,
          message: dockerEvaluatorContext.message,
          state: dockerEvaluatorContext.state,
          senderRole: "OWNER",
          turnSignal: new AbortController().signal,
        };
        await expect(
          dockerPlugin?.responseHandlerFieldEvaluators?.[0]?.parse?.(
            { raw: true },
            dockerFieldContext as never,
          ),
        ).resolves.toEqual({ parsed: { raw: true }, module: "primary" });
        await expect(
          dockerToolsPlugin?.responseHandlerFieldEvaluators?.[0]?.parse?.(
            { raw: true },
            dockerFieldContext as never,
          ),
        ).resolves.toEqual({ parsed: { raw: true }, module: "tools" });
        const dockerFieldEffect =
          await dockerPlugin?.responseHandlerFieldEvaluators?.[0]?.handle?.({
            ...dockerFieldContext,
            value: { raw: true },
            parsed: {
              shouldRespond: "RESPOND",
              contexts: [],
              intents: [],
              candidateActionNames: [],
              replyText: "",
              facts: [],
              relationships: [],
              addressedTo: [],
            },
          } as never);
        const dockerMutableResult = {
          shouldRespond: "RESPOND" as const,
          contexts: [],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        };
        dockerFieldEffect?.mutateResult?.(dockerMutableResult);
        expect(dockerMutableResult).toMatchObject({
          dockerFieldHandled: "primary",
        });
        await expect(
          (
            dockerPlugin?.events as Record<
              string,
              Array<(payload: unknown) => Promise<void> | void>
            >
          )?.["docker.event"]?.[0]?.({ runtime } as never),
        ).resolves.toBeUndefined();
        await expect(
          (
            dockerToolsPlugin?.events as Record<
              string,
              Array<(payload: unknown) => Promise<void> | void>
            >
          )?.["docker.tools.event"]?.[0]?.({ runtime } as never),
        ).resolves.toBeUndefined();
        const dockerService = runtime.getService(
          "docker_service",
        ) as unknown as { lookup: (...args: unknown[]) => Promise<unknown> };
        const dockerToolsService = runtime.getService(
          "docker_tools_service",
        ) as unknown as { lookup: (...args: unknown[]) => Promise<unknown> };
        await expect(
          dockerService.lookup({ query: "primary" }),
        ).resolves.toEqual({
          text: "docker primary service",
          args: [{ query: "primary" }],
        });
        await expect(
          dockerToolsService.lookup({ query: "tools" }),
        ).resolves.toEqual({
          text: "docker tools service",
          args: [{ query: "tools" }],
        });
        await expect(
          dockerPlugin?.appBridge?.prepareLaunch?.({ runtime } as never),
        ).resolves.toEqual({ launchUrl: "https://docker.example/primary" });
        await expect(
          dockerToolsPlugin?.appBridge?.prepareLaunch?.({ runtime } as never),
        ).resolves.toEqual({ launchUrl: "https://docker.example/tools" });
        const modelHandlers = (
          runtime as unknown as {
            models: Map<
              string,
              Array<{
                handler: (
                  runtime: IAgentRuntime,
                  params: unknown,
                ) => Promise<unknown>;
              }>
            >;
          }
        ).models;
        await expect(
          modelHandlers.get("DOCKER_TEXT")?.[0]?.handler(runtime, {
            prompt: "primary",
          }),
        ).resolves.toEqual({
          text: "docker model",
          module: "primary",
          params: { prompt: "primary" },
        });
        await expect(
          modelHandlers.get("DOCKER_TOOLS_TEXT")?.[0]?.handler(runtime, {
            prompt: "tools",
          }),
        ).resolves.toEqual({
          text: "docker tools model",
          module: "tools",
          params: { prompt: "tools" },
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
        await expect(
          dispatchRoute({
            runtime,
            method: "POST",
            path: "/docker-tools/route",
            headers: {},
            body: { dockerTools: true },
            inProcess: false,
            isAuthorized: () => false,
          }),
        ).resolves.toEqual({
          status: 210,
          headers: { "x-docker-tools-plugin": "yes" },
          body: { dockerToolsRoute: true, body: { dockerTools: true } },
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

function stringifyPluginConfig(
  config: NonNullable<Plugin["config"]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}

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
  const services = new Map<string, Service>();
  const runtime = makeRuntime(router, {
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    responseHandlerEvaluators: [],
    responseHandlerFieldEvaluators: [],
    routes: [],
    models: new Map(),
  } as never);
  runtime.getService = <T extends Service>(serviceType: string): T | null =>
    serviceType === CAPABILITY_ROUTER_SERVICE_TYPE
      ? (router as unknown as T)
      : ((services.get(serviceType) as T | undefined) ?? null);
  runtime.hasService = (serviceType: string) =>
    serviceType === CAPABILITY_ROUTER_SERVICE_TYPE || services.has(serviceType);
  runtime.getServiceLoadPromise = async <T extends Service>(
    serviceType: string,
  ): Promise<T> => {
    const service = runtime.getService<T>(serviceType);
    if (!service) throw new Error(`Service ${serviceType} not found`);
    return service;
  };
  runtime.registerPlugin = async (plugin: Plugin) => {
    runtime.plugins.push(plugin);
    runtime.actions.push(...(plugin.actions ?? []));
    runtime.providers.push(...(plugin.providers ?? []));
    runtime.evaluators.push(...(plugin.evaluators ?? []));
    runtime.responseHandlerEvaluators.push(
      ...(plugin.responseHandlerEvaluators ?? []),
    );
    runtime.responseHandlerFieldEvaluators.push(
      ...(plugin.responseHandlerFieldEvaluators ?? []),
    );
    for (const [modelType, handler] of Object.entries(plugin.models ?? {})) {
      if (typeof handler === "function") {
        const modelMap = (
          runtime as unknown as {
            models: Map<string, Array<{ handler: unknown; provider: string }>>;
          }
        ).models;
        const handlers = modelMap.get(modelType) ?? [];
        handlers.push({ handler, provider: plugin.name });
        modelMap.set(modelType, handlers);
      }
    }
    runtime.routes.push(...(plugin.routes ?? []));
    for (const ServiceClass of plugin.services ?? []) {
      services.set(ServiceClass.serviceType, await ServiceClass.start(runtime));
    }
    await registerPluginViews(plugin);
  };
  return runtime;
}

function makeLifecycleRuntime(router: ElizaCapabilityRouter): IAgentRuntime {
  const runtime = makeRuntime(router, {
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    responseHandlerEvaluators: [],
    responseHandlerFieldEvaluators: [],
    routes: [],
    events: {},
    services: new Map(),
    serviceTypes: new Map(),
    servicePromises: new Map(),
    servicePromiseHandlers: new Map(),
    startingServices: new Map(),
    serviceRegistrationStatus: new Map(),
    sendHandlers: new Map(),
    models: new Map(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  } as never);
  runtime.registerAction = (action) => {
    runtime.actions.push(action);
  };
  runtime.registerProvider = (provider) => {
    runtime.providers.push(provider);
  };
  runtime.registerEvaluator = (evaluator) => {
    runtime.evaluators.push(evaluator);
  };
  runtime.registerEvent = (event, handler) => {
    const handlers = runtime.events[event] ?? [];
    handlers.push(handler);
    runtime.events[event] = handlers;
  };
  runtime.registerModel = (modelType, handler, provider) => {
    const modelMap = (
      runtime as unknown as {
        models: Map<string, Array<{ handler: unknown; provider: string }>>;
      }
    ).models;
    const key = String(modelType);
    const handlers = modelMap.get(key) ?? [];
    handlers.push({ handler, provider });
    modelMap.set(key, handlers);
  };
  runtime.registerService = async () => {};
  runtime.registerPlugin = async (plugin) => {
    runtime.plugins.push(plugin);
    for (const action of plugin.actions ?? []) {
      runtime.registerAction(action);
    }
    for (const provider of plugin.providers ?? []) {
      runtime.registerProvider(provider);
    }
    for (const evaluator of plugin.evaluators ?? []) {
      runtime.registerEvaluator(evaluator);
    }
    for (const [event, handlers] of Object.entries(plugin.events ?? {})) {
      for (const handler of handlers) {
        runtime.registerEvent(event as never, handler as never);
      }
    }
    for (const [modelType, handler] of Object.entries(plugin.models ?? {})) {
      if (typeof handler === "function") {
        runtime.registerModel(
          modelType as never,
          handler as never,
          plugin.name,
        );
      }
    }
    runtime.routes.push(...(plugin.routes ?? []));
  };
  installRuntimePluginLifecycle(runtime as never);
  return runtime;
}

function makeProductConnectRuntime(): IAgentRuntime {
  const services = new Map<string, RemoteCapabilityRouterService[]>();
  const runtime = makeRuntime(null, {
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    routes: [],
    services: services as unknown as IAgentRuntime["services"],
    getSetting: () => null,
    getService: (<T>(serviceType: string): T | null =>
      (services.get(serviceType)?.[0] as T | undefined) ??
      null) as IAgentRuntime["getService"],
    hasService: (serviceType) => services.has(serviceType),
    registerService: async (ServiceClass) => {
      const service = new (
        ServiceClass as typeof RemoteCapabilityRouterService
      )(runtime);
      services.set(ServiceClass.serviceType, [service]);
    },
    getServiceLoadPromise: async (serviceType) => {
      const service = services.get(serviceType)?.[0];
      if (!service) throw new Error("service not registered");
      return service as never;
    },
    registerPlugin: async (plugin: Plugin) => {
      runtime.plugins.push(plugin);
      runtime.actions.push(...(plugin.actions ?? []));
      runtime.providers.push(...(plugin.providers ?? []));
      runtime.evaluators.push(...(plugin.evaluators ?? []));
      runtime.routes.push(...(plugin.routes ?? []));
      await registerPluginViews(plugin);
    },
  });
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
      shouldRunResponseHandlerEvaluator: unavailable,
      evaluateResponseHandlerEvaluator: unavailable,
      shouldRunResponseHandlerFieldEvaluator: unavailable,
      parseResponseHandlerFieldEvaluator: unavailable,
      handleResponseHandlerFieldEvaluator: unavailable,
      callLifecycle: unavailable,
      handleEvent: unavailable,
      invokeModel: unavailable,
      callService: unavailable,
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
