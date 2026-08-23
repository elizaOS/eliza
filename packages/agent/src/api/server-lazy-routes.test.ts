/**
 * Covers server-lazy-routes: cheap path/method guards on every handle* shim
 * (false without loading the inner module), isPublicRuntimePluginRoute — the
 * exported owner of matchPluginRoutePath (empty runtime, exact, param,
 * wildcard, decode success/failure, extra/missing segments, STATIC skip,
 * public flag, method case), runtime/hono match gates, and a handful of real
 * dispatches through cheap inner modules. Deterministic; no live model.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectorHealthMonitor,
  handleAccountsRoutes,
  handleAgentAdminRoutes,
  handleAgentLifecycleRoutes,
  handleAgentStatusRoutes,
  handleAgentTransferRoutes,
  handleAppPackageRoutes,
  handleAuthRoutes,
  handleAvatarRoutes,
  handleBackgroundTasksRoute,
  handleBugReportRoutes,
  handleCharacterRoutes,
  handleCloudAndCoreRouteGroup,
  handleCommandsRoutes,
  handleConfigRoutes,
  handleConnectorRoutes,
  handleConversationRouteGroup,
  handleDatabaseRouteGroup,
  handleDiagnosticsRoutes,
  handleFirstRunRoutes,
  handleHealthRoutes,
  handleInboxAndCloudRelayRouteGroup,
  handleInteractionsRoutes,
  handleLifeOpsRuntimePluginRoute,
  handleMemoryRoutes,
  handleMiscRoutes,
  handleMobileOptionalRoutes,
  handleModelConfigRoutes,
  handleModelsRoutes,
  handlePermissionRoutes,
  handlePermissionsExtraRoutes,
  handleProjectRoutes,
  handleProviderSwitchRoutes,
  handleRegistryRoutes,
  handleRelationshipsRoutes,
  handleRemoteCapabilityRoutes,
  handleSandboxRouteGroup,
  handleSubscriptionRoutes,
  handleUpdateRoutes,
  handleViewsRoutes,
  handleWorkbenchRoutes,
  isPublicRuntimePluginRoute,
  tryHandleHonoRuntimeRoute,
  tryHandleLifeOpsInboxFallbackLazy,
  tryHandleRuntimePluginRoute,
} from "./server-lazy-routes";

function asCtx(method: string, pathname: string): never {
  return { method, pathname } as never;
}

function publicGet(path: string): Route {
  return {
    type: "GET",
    path,
    public: true,
    name: "public-get",
    publicReason: "unit-test public route",
  };
}

function runtimeWithRoutes(routes: Route[]): AgentRuntime {
  return { routes } as AgentRuntime;
}

describe("isPublicRuntimePluginRoute", () => {
  it("is false for a missing runtime, empty routes, and an empty queue", () => {
    expect(
      isPublicRuntimePluginRoute({
        runtime: null,
        method: "GET",
        pathname: "/r",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime: undefined,
        method: "GET",
        pathname: "/r",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime: {} as AgentRuntime,
        method: "GET",
        pathname: "/r",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([]),
        method: "GET",
        pathname: "/r",
      }),
    ).toBe(false);
  });

  it("matches a single exact public route and is case-insensitive on method", () => {
    const runtime = runtimeWithRoutes([publicGet("/hook")]);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/hook",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "get",
        pathname: "/hook",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "POST",
        pathname: "/hook",
      }),
    ).toBe(false);
  });

  it("skips STATIC routes and non-public routes even when the path matches", () => {
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([
          {
            type: "STATIC",
            path: "/hook",
            public: true,
            name: "static",
            publicReason: "unit-test",
          },
        ]),
        method: "GET",
        pathname: "/hook",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([
          { type: "GET", path: "/hook", public: false },
        ]),
        method: "GET",
        pathname: "/hook",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([{ type: "GET", path: "/hook" }]),
        method: "GET",
        pathname: "/hook",
      }),
    ).toBe(false);
  });

  it("does not treat a missing path as a match (lookup of an absent item)", () => {
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([publicGet("/hook")]),
        method: "GET",
        pathname: "/other",
      }),
    ).toBe(false);
  });

  it("captures :param segments and decodeURIComponent, including a decode miss", () => {
    const runtime = runtimeWithRoutes([publicGet("/r/:id")]);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/r/abc",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/r/hello%20world",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/r/%E0%A4%A",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/r",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/r/abc/extra",
      }),
    ).toBe(false);
  });

  it("matches :rest* wildcards, rejects an empty tail, and ties on the first hit", () => {
    const runtime = runtimeWithRoutes([
      publicGet("/files/:rest*"),
      publicGet("/files/:rest*"),
    ]);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/files/a",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/files/a/b%20c",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/files",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/nope/a",
      }),
    ).toBe(false);
  });

  it("normalizes empty slash segments so //r//x matches /r/x", () => {
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([publicGet("/r/x")]),
        method: "GET",
        pathname: "//r//x",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([publicGet("/")]),
        method: "GET",
        pathname: "/",
      }),
    ).toBe(true);
  });

  it("rejects a literal segment mismatch", () => {
    expect(
      isPublicRuntimePluginRoute({
        runtime: runtimeWithRoutes([publicGet("/r/foo")]),
        method: "GET",
        pathname: "/r/bar",
      }),
    ).toBe(false);
  });
});

describe("lazy handle* path guards", () => {
  const guards: Array<{
    name: string;
    handle: (ctx: never) => Promise<boolean>;
  }> = [
    { name: "handleAccountsRoutes", handle: handleAccountsRoutes },
    { name: "handleAgentAdminRoutes", handle: handleAgentAdminRoutes },
    { name: "handleAgentLifecycleRoutes", handle: handleAgentLifecycleRoutes },
    { name: "handleAgentStatusRoutes", handle: handleAgentStatusRoutes },
    { name: "handleAgentTransferRoutes", handle: handleAgentTransferRoutes },
    { name: "handleAppPackageRoutes", handle: handleAppPackageRoutes },
    { name: "handleAuthRoutes", handle: handleAuthRoutes },
    { name: "handleAvatarRoutes", handle: handleAvatarRoutes },
    { name: "handleInteractionsRoutes", handle: handleInteractionsRoutes },
    { name: "handleCommandsRoutes", handle: handleCommandsRoutes },
    { name: "handleBackgroundTasksRoute", handle: handleBackgroundTasksRoute },
    { name: "handleBugReportRoutes", handle: handleBugReportRoutes },
    { name: "handleCharacterRoutes", handle: handleCharacterRoutes },
    { name: "handleConfigRoutes", handle: handleConfigRoutes },
    { name: "handleConnectorRoutes", handle: handleConnectorRoutes },
    { name: "handleDiagnosticsRoutes", handle: handleDiagnosticsRoutes },
    { name: "handleFirstRunRoutes", handle: handleFirstRunRoutes },
    { name: "handleHealthRoutes", handle: handleHealthRoutes },
    { name: "handleMemoryRoutes", handle: handleMemoryRoutes },
    { name: "handleMiscRoutes", handle: handleMiscRoutes },
    { name: "handleModelsRoutes", handle: handleModelsRoutes },
    { name: "handleModelConfigRoutes", handle: handleModelConfigRoutes },
    { name: "handlePermissionRoutes", handle: handlePermissionRoutes },
    { name: "handleProjectRoutes", handle: handleProjectRoutes },
    {
      name: "handlePermissionsExtraRoutes",
      handle: handlePermissionsExtraRoutes,
    },
    { name: "handleProviderSwitchRoutes", handle: handleProviderSwitchRoutes },
    { name: "handleRegistryRoutes", handle: handleRegistryRoutes },
    { name: "handleRelationshipsRoutes", handle: handleRelationshipsRoutes },
    {
      name: "handleRemoteCapabilityRoutes",
      handle: handleRemoteCapabilityRoutes,
    },
    {
      name: "handleInboxAndCloudRelayRouteGroup",
      handle: handleInboxAndCloudRelayRouteGroup,
    },
    {
      name: "handleCloudAndCoreRouteGroup",
      handle: handleCloudAndCoreRouteGroup,
    },
    { name: "handleSandboxRouteGroup", handle: handleSandboxRouteGroup },
    {
      name: "handleConversationRouteGroup",
      handle: handleConversationRouteGroup,
    },
    { name: "handleDatabaseRouteGroup", handle: handleDatabaseRouteGroup },
    {
      name: "handleLifeOpsRuntimePluginRoute",
      handle: handleLifeOpsRuntimePluginRoute,
    },
    { name: "handleSubscriptionRoutes", handle: handleSubscriptionRoutes },
    { name: "handleUpdateRoutes", handle: handleUpdateRoutes },
    { name: "handleViewsRoutes", handle: handleViewsRoutes },
    { name: "handleWorkbenchRoutes", handle: handleWorkbenchRoutes },
  ];

  it("returns false for an unrelated path on every ctx-based shim", async () => {
    for (const { handle, name } of guards) {
      await expect(
        handle(asCtx("GET", "/definitely-not-a-route")),
        name,
      ).resolves.toBe(false);
    }
  });

  it("returns false when routeContext cannot read method/pathname", async () => {
    await expect(handleAccountsRoutes(undefined as never)).resolves.toBe(false);
    await expect(handleAccountsRoutes(null as never)).resolves.toBe(false);
    await expect(handleAccountsRoutes(42 as never)).resolves.toBe(false);
    await expect(handleAccountsRoutes({} as never)).resolves.toBe(false);
    await expect(
      handleAccountsRoutes({ method: "GET" } as never),
    ).resolves.toBe(false);
    await expect(
      handleAccountsRoutes({ pathname: "/api/accounts" } as never),
    ).resolves.toBe(false);
    await expect(
      handleAccountsRoutes({ method: 1, pathname: "/api/accounts" } as never),
    ).resolves.toBe(false);
  });

  it("distinguishes prefix, exact, and regex edges without loading inners", async () => {
    await expect(
      handleAccountsRoutes(asCtx("GET", "/api/account")),
    ).resolves.toBe(false);
    await expect(
      handleAccountsRoutes(asCtx("GET", "/api/provider")),
    ).resolves.toBe(false);
    await expect(
      handleAgentAdminRoutes(asCtx("POST", "/api/agent/restart/x")),
    ).resolves.toBe(false);
    await expect(
      handleAgentLifecycleRoutes(asCtx("POST", "/api/agent/restart")),
    ).resolves.toBe(false);
    await expect(
      handleAgentTransferRoutes(asCtx("POST", "/api/agent/export/")),
    ).resolves.toBe(false);
    await expect(
      handleAppPackageRoutes(asCtx("GET", "/api/apps")),
    ).resolves.toBe(false);
    await expect(handleAuthRoutes(asCtx("GET", "/api/auth"))).resolves.toBe(
      false,
    );
    await expect(
      handleInteractionsRoutes(asCtx("GET", "/api/interactions")),
    ).resolves.toBe(false);
    await expect(
      handleCommandsRoutes(asCtx("GET", "/api/commands/")),
    ).resolves.toBe(false);
    await expect(
      handleConfigRoutes(asCtx("GET", "/api/config/foo")),
    ).resolves.toBe(false);
    await expect(
      handlePermissionsExtraRoutes(asCtx("GET", "/api/permissions")),
    ).resolves.toBe(false);
    await expect(
      handleCloudAndCoreRouteGroup(asCtx("GET", "/api/cloud")),
    ).resolves.toBe(false);
    await expect(
      handleDatabaseRouteGroup(asCtx("GET", "/api/database")),
    ).resolves.toBe(false);
    await expect(
      handleSubscriptionRoutes(asCtx("GET", "/api/subscription")),
    ).resolves.toBe(false);
    await expect(
      handleConversationRouteGroup(asCtx("GET", "/api/agents/abc/message")),
    ).resolves.toBe(false);
    await expect(
      handleConversationRouteGroup(asCtx("POST", "/api/agents/a/b/message")),
    ).resolves.toBe(false);
    await expect(
      handleMiscRoutes(asCtx("POST", "/api/agents//event")),
    ).resolves.toBe(false);
    await expect(
      handleModelsRoutes(asCtx("GET", "/api/models/config")),
    ).resolves.toBe(false);
  });
});

describe("handleMobileOptionalRoutes guard (args[2] pathname)", () => {
  const req = {} as http.IncomingMessage;
  const res = {} as http.ServerResponse;

  it("returns false when the third argument is not a matching pathname", async () => {
    await expect(
      handleMobileOptionalRoutes(req, res, "/nope", "GET"),
    ).resolves.toBe(false);
    await expect(
      handleMobileOptionalRoutes(req, res, 1 as never, "GET"),
    ).resolves.toBe(false);
    await expect(
      handleMobileOptionalRoutes(req, res, "/api/computer-use", "GET"),
    ).resolves.toBe(false);
  });
});

describe("tryHandleLifeOpsInboxFallbackLazy", () => {
  function makeRes() {
    const headers = new Map<string, string>();
    let body = "";
    const res = {
      statusCode: 0,
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      end(value?: string) {
        body = value ?? "";
      },
    } as unknown as http.ServerResponse;
    return {
      res,
      get status() {
        return (res as { statusCode: number }).statusCode;
      },
      get body() {
        return JSON.parse(body) as Record<string, unknown>;
      },
    };
  }

  it("returns false off the inbox path without loading the fallback", async () => {
    await expect(
      tryHandleLifeOpsInboxFallbackLazy({
        pathname: "/api/lifeops/goals",
        method: "GET",
        url: new URL("http://localhost/api/lifeops/goals"),
        res: makeRes().res,
      }),
    ).resolves.toBe(false);
    await expect(tryHandleLifeOpsInboxFallbackLazy({} as never)).resolves.toBe(
      false,
    );
  });

  it("forwards GET /api/lifeops/inbox to the real empty-inbox fallback", async () => {
    const captured = makeRes();
    await expect(
      tryHandleLifeOpsInboxFallbackLazy({
        pathname: "/api/lifeops/inbox",
        method: "GET",
        url: new URL("http://localhost/api/lifeops/inbox"),
        res: captured.res,
      }),
    ).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body.messages).toEqual([]);
    expect(captured.body.available).toBe(false);
  });

  it("forwards an invalid channels query and returns the real 400", async () => {
    const captured = makeRes();
    await expect(
      tryHandleLifeOpsInboxFallbackLazy({
        pathname: "/api/lifeops/inbox",
        method: "GET",
        url: new URL("http://localhost/api/lifeops/inbox?channels=nope"),
        res: captured.res,
      }),
    ).resolves.toBe(true);
    expect(captured.status).toBe(400);
    expect(String(captured.body.error ?? "")).toContain("channels must be");
  });
});

describe("runtime and hono match gates", () => {
  it("tryHandleRuntimePluginRoute is false with no matching runtime route", async () => {
    await expect(
      tryHandleRuntimePluginRoute({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: "GET",
        pathname: "/plugin/x",
        url: new URL("http://localhost/plugin/x"),
        runtime: null,
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);
    await expect(
      tryHandleRuntimePluginRoute({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: "GET",
        pathname: "/plugin/x",
        url: new URL("http://localhost/plugin/x"),
        runtime: runtimeWithRoutes([
          {
            type: "STATIC",
            path: "/plugin/x",
          },
        ]),
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);
  });

  it("handleLifeOpsRuntimePluginRoute is false without a matching runtime route", async () => {
    await expect(
      handleLifeOpsRuntimePluginRoute(asCtx("GET", "/lifeops/x")),
    ).resolves.toBe(false);
    await expect(
      handleLifeOpsRuntimePluginRoute({
        method: "GET",
        pathname: "/lifeops/x",
        state: { runtime: runtimeWithRoutes([]) },
      } as never),
    ).resolves.toBe(false);
  });

  it("tryHandleHonoRuntimeRoute is false without a routeHandler match", async () => {
    await expect(
      tryHandleHonoRuntimeRoute({
        req: {
          method: "GET",
          url: "/hono/x",
          headers: { host: "localhost" },
        } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        runtime: null,
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);

    await expect(
      tryHandleHonoRuntimeRoute({
        req: {
          method: undefined,
          url: undefined,
          headers: {},
        } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        runtime: runtimeWithRoutes([]),
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);

    await expect(
      tryHandleHonoRuntimeRoute({
        req: {
          method: "GET",
          url: "http://[",
          headers: { host: "localhost" },
        } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        runtime: runtimeWithRoutes([
          {
            type: "GET",
            path: "/hono/x",
          },
        ]),
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);

    await expect(
      tryHandleHonoRuntimeRoute({
        req: {
          method: "GET",
          url: "/hono/x",
          headers: { host: "localhost" },
        } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        runtime: runtimeWithRoutes([
          {
            type: "GET",
            path: "/hono/x",
          },
        ]),
        isAuthorized: () => true,
      }),
    ).resolves.toBe(false);
  });
});

describe("real dispatches through cheap inner modules", () => {
  it("createConnectorHealthMonitor constructs the real monitor", async () => {
    const monitor = await createConnectorHealthMonitor({
      runtime: { getService: vi.fn() } as never,
      config: { connectors: {} },
      broadcastWs: vi.fn(),
      intervalMs: 60_000,
    });
    expect(monitor.getConnectorStatuses()).toEqual({});
    monitor.stop();
  });
});

describe("tryHandleRuntimePluginRoute forwards a matching plugin route", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  it("dispatches a legacy handler through the lazy wrapper", async () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/lazy-ping",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.json({ ping: true });
          },
        },
      ],
    } as unknown as AgentRuntime;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        runtime,
        isAuthorized: () => true,
      });
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/plugin/lazy-ping`,
    );
    await expect(response.json()).resolves.toEqual({ ping: true });
    expect(response.status).toBe(200);
  });
});
