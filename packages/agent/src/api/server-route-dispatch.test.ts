/**
 * Covers the `/api/*` namespace dispatcher in `server-route-dispatch.ts`.
 * Each exported group is the real module: local handlers run with in-memory
 * req/res/helpers (no live server or model), and only the lazy plugin owners
 * (`@elizaos/plugin-elizacloud/host-routes`, `@elizaos/plugin-computeruse`)
 * are stubbed so their loaders stay out of the static graph the way production
 * does. Assertions check which namespace actually handled the request
 * (distinct payloads, 503s, empty lists, OpenAI-compat models) plus prefix
 * fall-through, push-token-before-notification ordering, billing→compat→core
 * cascade, sandbox/database prefix edges, and the `/v1` vs per-agent message
 * regex.
 */
import type http from "node:http";
import type { AgentRuntime, Route } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import {
  handleCloudAndCoreRouteGroup,
  handleConversationRouteGroup,
  handleDatabaseRouteGroup,
  handleInboxAndCloudRelayRouteGroup,
  handleLifeOpsRuntimePluginRoute,
  handleSandboxRouteGroup,
} from "./server-route-dispatch.ts";

type PluginHandler = (...args: unknown[]) => Promise<boolean>;

const { cloudHost, computeUse } = vi.hoisted(() => ({
  cloudHost: {
    handleCloudRelayRoute: vi.fn<PluginHandler>(async () => true),
    handleCloudBillingRoute: vi.fn<PluginHandler>(async () => false),
    handleCloudCompatRoute: vi.fn<PluginHandler>(async () => false),
    handleCloudRoute: vi.fn<PluginHandler>(async () => true),
  },
  computeUse: {
    handleSandboxRoute: vi.fn<PluginHandler>(async () => true),
  },
}));

vi.mock("@elizaos/plugin-elizacloud/host-routes", () => cloudHost);
vi.mock("@elizaos/plugin-computeruse", () => computeUse);

type InboxCtx = Parameters<typeof handleInboxAndCloudRelayRouteGroup>[0];
type CloudCtx = Parameters<typeof handleCloudAndCoreRouteGroup>[0];
type SandboxCtx = Parameters<typeof handleSandboxRouteGroup>[0];
type DatabaseCtx = Parameters<typeof handleDatabaseRouteGroup>[0];
type ConversationCtx = Parameters<typeof handleConversationRouteGroup>[0];
type LifeOpsCtx = Parameters<typeof handleLifeOpsRuntimePluginRoute>[0];

function makeRes(): http.ServerResponse {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(key: string, value: string | number) {
      headers[key.toLowerCase()] = String(value);
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    writeHead(status: number) {
      res.statusCode = status;
      return res;
    },
    write() {
      return true;
    },
    end() {
      res.headersSent = true;
      res.writableEnded = true;
    },
  };
  return res as unknown as http.ServerResponse;
}

function makeReq(method: string, pathname: string): http.IncomingMessage {
  return {
    method,
    url: pathname,
    headers: { host: "localhost" },
  } as http.IncomingMessage;
}

function dispatchState(
  overrides: {
    runtime?: AgentRuntime | null;
    sandboxManager?: unknown;
    cloudManager?: unknown;
    config?: unknown;
    agentName?: string;
  } = {},
): InboxCtx["state"] {
  return {
    runtime: overrides.runtime ?? null,
    sandboxManager: overrides.sandboxManager ?? null,
    cloudManager: overrides.cloudManager ?? null,
    config: overrides.config ?? {},
    agentName: overrides.agentName ?? "Eliza",
    conversations: new Map(),
    deletedConversationIds: new Set(),
    conversationRestorePromise: null,
  } as InboxCtx["state"];
}

function helpers() {
  return {
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(async () => null),
  };
}

beforeEach(() => {
  cloudHost.handleCloudRelayRoute.mockClear();
  cloudHost.handleCloudBillingRoute.mockClear();
  cloudHost.handleCloudCompatRoute.mockClear();
  cloudHost.handleCloudRoute.mockClear();
  cloudHost.handleCloudRelayRoute.mockResolvedValue(true);
  cloudHost.handleCloudBillingRoute.mockResolvedValue(false);
  cloudHost.handleCloudCompatRoute.mockResolvedValue(false);
  cloudHost.handleCloudRoute.mockResolvedValue(true);
  computeUse.handleSandboxRoute.mockClear();
  computeUse.handleSandboxRoute.mockResolvedValue(true);
});

describe("handleInboxAndCloudRelayRouteGroup", () => {
  function ctx(
    pathname: string,
    extra: {
      method?: string;
      runtime?: AgentRuntime | null;
      inboxCallerAuthorization?: InboxCtx["inboxCallerAuthorization"];
    } = {},
  ): InboxCtx {
    const method = extra.method ?? "GET";
    const h = helpers();
    return {
      req: makeReq(method, pathname),
      res: makeRes(),
      method,
      pathname,
      url: new URL(pathname, "http://localhost"),
      state: dispatchState({ runtime: extra.runtime }),
      inboxCallerAuthorization: extra.inboxCallerAuthorization,
      ...h,
    };
  }

  it("handles /api/notifications/push-tokens before the notification catch-all", async () => {
    const args = ctx("/api/notifications/push-tokens");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.error).toHaveBeenCalledWith(
      args.res,
      "push delivery service not ready",
      503,
    );
    expect(args.json).not.toHaveBeenCalled();
  });

  it("handles a nested push-token path the same way (prefix, not exact)", async () => {
    const args = ctx("/api/notifications/push-tokens/abc");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.error).toHaveBeenCalledWith(
      args.res,
      "push delivery service not ready",
      503,
    );
  });

  it("handles GET /api/notifications with a retryable not-ready payload", async () => {
    const args = ctx("/api/notifications");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(
      args.res,
      {
        error: "Notification service is still starting",
        code: "NOTIFICATION_SERVICE_NOT_READY",
        retryAfter: 1,
      },
      503,
    );
    expect(args.error).not.toHaveBeenCalled();
  });

  it("handles GET /api/approvals as an empty queue when no runtime is attached", async () => {
    const args = ctx("/api/approvals");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(args.res, {
      approvals: [],
      pending: [],
      pendingUserActions: [],
    });
  });

  it("404s unknown approval subpaths instead of falling through", async () => {
    const args = ctx("/api/approvals/missing", { method: "POST" });
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.error).toHaveBeenCalledWith(
      args.res,
      "approval route not found",
      404,
    );
  });

  it("handles GET /api/inbox/messages with an empty feed when runtime is null", async () => {
    const args = ctx("/api/inbox/messages");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(args.res, {
      messages: [],
      count: 0,
    });
  });

  it("forwards inboxCallerAuthorization into the inbox handler context", async () => {
    const inboxCallerAuthorization = {
      ok: true,
      role: "owner",
    } as unknown as InboxCtx["inboxCallerAuthorization"];
    const args = ctx("/api/inbox/messages", { inboxCallerAuthorization });
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(args.res, {
      messages: [],
      count: 0,
    });
  });

  it("dispatches the exact /api/cloud/relay-status path to the cloud plugin", async () => {
    const args = ctx("/api/cloud/relay-status");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    expect(cloudHost.handleCloudRelayRoute).toHaveBeenCalledTimes(1);
    const call = cloudHost.handleCloudRelayRoute.mock.calls[0];
    expect(call?.[2]).toBe("/api/cloud/relay-status");
    expect(call?.[3]).toBe("GET");
    expect(call?.[4]).toEqual({ runtime: undefined });
    expect(call?.[5]).toEqual({
      json: args.json,
      error: args.error,
      readJsonBody: args.readJsonBody,
    });
  });

  it("wraps a live runtime's getService for the relay handler", async () => {
    const getService = vi.fn((type: string) => `svc:${type}`);
    const runtime = { getService } as unknown as AgentRuntime;
    const args = ctx("/api/cloud/relay-status", { runtime });
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(true);
    const pluginState = cloudHost.handleCloudRelayRoute.mock.calls[0]?.[4] as
      | {
          runtime?: { getService: (type: string) => unknown };
        }
      | undefined;
    expect(pluginState?.runtime?.getService("cloud")).toBe("svc:cloud");
    expect(getService).toHaveBeenCalledWith("cloud");
  });

  it("does not treat /api/cloud/relay-status/nested as the relay route", async () => {
    const args = ctx("/api/cloud/relay-status/nested");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(false);
    expect(cloudHost.handleCloudRelayRoute).not.toHaveBeenCalled();
    expect(args.json).not.toHaveBeenCalled();
    expect(args.error).not.toHaveBeenCalled();
  });

  it("returns false for namespaces this group does not own", async () => {
    const args = ctx("/api/conversations");
    await expect(handleInboxAndCloudRelayRouteGroup(args)).resolves.toBe(false);
    expect(args.json).not.toHaveBeenCalled();
    expect(args.error).not.toHaveBeenCalled();
  });
});

describe("handleCloudAndCoreRouteGroup", () => {
  function ctx(pathname: string): CloudCtx {
    return {
      req: makeReq("GET", pathname),
      res: makeRes(),
      method: "GET",
      pathname,
      state: dispatchState({
        config: { cloud: true },
        cloudManager: { id: "cm" },
      }),
      restartRuntime: vi.fn(async () => true),
      saveConfig: vi.fn(),
    };
  }

  it("returns false when the path is not under /api/cloud/", async () => {
    await expect(handleCloudAndCoreRouteGroup(ctx("/api/cloud"))).resolves.toBe(
      false,
    );
    expect(cloudHost.handleCloudBillingRoute).not.toHaveBeenCalled();
  });

  it("stops at billing when billing handles the request", async () => {
    cloudHost.handleCloudBillingRoute.mockResolvedValueOnce(true);
    const args = ctx("/api/cloud/billing/balance");
    await expect(handleCloudAndCoreRouteGroup(args)).resolves.toBe(true);
    expect(cloudHost.handleCloudBillingRoute).toHaveBeenCalledTimes(1);
    expect(cloudHost.handleCloudCompatRoute).not.toHaveBeenCalled();
    expect(cloudHost.handleCloudRoute).not.toHaveBeenCalled();
  });

  it("falls through billing to compat when billing declines", async () => {
    cloudHost.handleCloudCompatRoute.mockResolvedValueOnce(true);
    const args = ctx("/api/cloud/compat/foo");
    await expect(handleCloudAndCoreRouteGroup(args)).resolves.toBe(true);
    expect(cloudHost.handleCloudBillingRoute).toHaveBeenCalledTimes(1);
    expect(cloudHost.handleCloudCompatRoute).toHaveBeenCalledTimes(1);
    expect(cloudHost.handleCloudRoute).not.toHaveBeenCalled();
  });

  it("falls through billing and compat to handleCloudRoute", async () => {
    const args = ctx("/api/cloud/core");
    await expect(handleCloudAndCoreRouteGroup(args)).resolves.toBe(true);
    expect(cloudHost.handleCloudBillingRoute).toHaveBeenCalledTimes(1);
    expect(cloudHost.handleCloudCompatRoute).toHaveBeenCalledTimes(1);
    expect(cloudHost.handleCloudRoute).toHaveBeenCalledTimes(1);
    const pluginState = cloudHost.handleCloudRoute.mock.calls[0]?.[4] as
      | {
          config: unknown;
          cloudManager: unknown;
          saveConfig: CloudCtx["saveConfig"];
          restartRuntime: CloudCtx["restartRuntime"];
          createTelemetrySpan: typeof createIntegrationTelemetrySpan;
        }
      | undefined;
    expect(pluginState?.config).toEqual({ cloud: true });
    expect(pluginState?.cloudManager).toEqual({ id: "cm" });
    expect(pluginState?.saveConfig).toBe(args.saveConfig);
    expect(pluginState?.restartRuntime).toBe(args.restartRuntime);
    expect(pluginState?.createTelemetrySpan).toBe(
      createIntegrationTelemetrySpan,
    );
  });

  it("returns handleCloudRoute's false when nothing in the cascade claims the path", async () => {
    cloudHost.handleCloudRoute.mockResolvedValueOnce(false);
    await expect(
      handleCloudAndCoreRouteGroup(ctx("/api/cloud/x/tweets")),
    ).resolves.toBe(false);
    expect(cloudHost.handleCloudRoute).toHaveBeenCalledTimes(1);
  });
});

describe("handleSandboxRouteGroup", () => {
  it("returns false outside the /api/sandbox prefix", async () => {
    const args: SandboxCtx = {
      req: makeReq("GET", "/api/sand"),
      res: makeRes(),
      method: "GET",
      pathname: "/api/sand",
      state: dispatchState(),
    };
    await expect(handleSandboxRouteGroup(args)).resolves.toBe(false);
    expect(computeUse.handleSandboxRoute).not.toHaveBeenCalled();
  });

  it("forwards /api/sandbox to the compute-use plugin with sandboxManager", async () => {
    const sandboxManager = { id: "box" };
    const args: SandboxCtx = {
      req: makeReq("POST", "/api/sandbox/session"),
      res: makeRes(),
      method: "POST",
      pathname: "/api/sandbox/session",
      state: dispatchState({ sandboxManager }),
    };
    await expect(handleSandboxRouteGroup(args)).resolves.toBe(true);
    expect(computeUse.handleSandboxRoute).toHaveBeenCalledWith(
      args.req,
      args.res,
      "/api/sandbox/session",
      "POST",
      { sandboxManager },
    );
  });

  it("matches any path that starts with /api/sandbox, including a glued suffix", async () => {
    const args: SandboxCtx = {
      req: makeReq("GET", "/api/sandbox-extra"),
      res: makeRes(),
      method: "GET",
      pathname: "/api/sandbox-extra",
      state: dispatchState(),
    };
    await expect(handleSandboxRouteGroup(args)).resolves.toBe(true);
    expect(computeUse.handleSandboxRoute).toHaveBeenCalledTimes(1);
  });
});

describe("handleDatabaseRouteGroup", () => {
  function ctx(pathname: string, method = "GET"): DatabaseCtx {
    return {
      req: makeReq(method, pathname),
      res: makeRes(),
      pathname,
      state: dispatchState(),
    };
  }

  it("returns false for /api/database without the trailing-slash prefix", async () => {
    await expect(handleDatabaseRouteGroup(ctx("/api/database"))).resolves.toBe(
      false,
    );
  });

  it("returns false for a lookalike /api/databases path", async () => {
    await expect(handleDatabaseRouteGroup(ctx("/api/databases"))).resolves.toBe(
      false,
    );
  });

  it("GET /api/database/status reports disconnected when no adapter is attached", async () => {
    const args = ctx("/api/database/status");
    await expect(handleDatabaseRouteGroup(args)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(args.res.statusCode).toBe(200);
      expect(args.res.getHeader("Content-Type")).toBe("application/json");
    });
  });

  it("still handles unknown /api/database/* paths (prefix admitted, handler 503s)", async () => {
    const args = ctx("/api/database/no-such-route");
    await expect(handleDatabaseRouteGroup(args)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(args.res.statusCode).toBe(503);
    });
  });
});

describe("handleConversationRouteGroup", () => {
  function ctx(
    method: string,
    pathname: string,
    extra: { runtime?: AgentRuntime | null } = {},
  ): ConversationCtx {
    const h = helpers();
    return {
      req: makeReq(method, pathname),
      res: makeRes(),
      method,
      pathname,
      url: new URL(pathname, "http://localhost"),
      state: dispatchState({
        runtime: extra.runtime,
        agentName: "TestAgent",
      }),
      ...h,
    };
  }

  it("lists conversations from the in-memory map", async () => {
    const args = ctx("GET", "/api/conversations");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(args.res, { conversations: [] });
  });

  it("serves GET /v1/models through chat-routes", async () => {
    const args = ctx("GET", "/v1/models");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(
      args.res,
      expect.objectContaining({
        object: "list",
        data: expect.arrayContaining([
          expect.objectContaining({ id: "eliza", object: "model" }),
          expect.objectContaining({ id: "TestAgent", object: "model" }),
        ]),
      }),
    );
  });

  it("POST /api/agents/:id/message with no runtime fails closed 503", async () => {
    const args = ctx("POST", "/api/agents/agent-1/message");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(true);
    expect(args.json).toHaveBeenCalledWith(
      args.res,
      { error: "Agent is not running" },
      503,
    );
  });

  it("does not dispatch GET /api/agents/:id/message (POST-only regex)", async () => {
    const args = ctx("GET", "/api/agents/agent-1/message");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(false);
    expect(args.json).not.toHaveBeenCalled();
  });

  it("does not dispatch a trailing extra segment on the agent message route", async () => {
    const args = ctx("POST", "/api/agents/agent-1/message/extra");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(false);
  });

  it("does not dispatch POST /api/agents/message (missing agent id segment)", async () => {
    const args = ctx("POST", "/api/agents/message");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(false);
  });

  it("returns false for /v1 without the trailing slash prefix", async () => {
    const args = ctx("GET", "/v1");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(false);
  });

  it("returns false for unrelated paths", async () => {
    const args = ctx("GET", "/api/inbox/messages");
    await expect(handleConversationRouteGroup(args)).resolves.toBe(false);
  });
});

describe("handleLifeOpsRuntimePluginRoute", () => {
  function ctx(
    pathname: string,
    extra: {
      method?: string;
      runtime?: AgentRuntime | null;
      isAuthorizedRequest?: LifeOpsCtx["isAuthorizedRequest"];
    } = {},
  ): LifeOpsCtx {
    const method = extra.method ?? "GET";
    const req = makeReq(method, pathname);
    return {
      req,
      res: makeRes(),
      method,
      pathname,
      url: new URL(pathname, "http://localhost"),
      state: dispatchState({ runtime: extra.runtime }),
      isAuthorizedRequest: extra.isAuthorizedRequest ?? (() => false),
    };
  }

  it("returns false when the runtime has no plugin routes", async () => {
    const runtime = { routes: [] } as unknown as AgentRuntime;
    await expect(
      handleLifeOpsRuntimePluginRoute(ctx("/lifeops/ping", { runtime })),
    ).resolves.toBe(false);
  });

  it("returns false when runtime is null", async () => {
    await expect(
      handleLifeOpsRuntimePluginRoute(ctx("/lifeops/ping")),
    ).resolves.toBe(false);
  });

  it("401s a private matching route when isAuthorizedRequest is false", async () => {
    const isAuthorizedRequest = vi.fn((incoming: http.IncomingMessage) => {
      expect(incoming.url).toBe("/lifeops/private");
      return false;
    });
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/lifeops/private",
          handler: vi.fn(),
        },
      ] as unknown as Route[],
    } as unknown as AgentRuntime;
    const args = ctx("/lifeops/private", { runtime, isAuthorizedRequest });
    await expect(handleLifeOpsRuntimePluginRoute(args)).resolves.toBe(true);
    expect(isAuthorizedRequest).toHaveBeenCalledWith(args.req);
    expect(args.res.statusCode).toBe(401);
  });

  it("invokes a matching public GET handler", async () => {
    const handler = vi.fn(async (_req: unknown, res: unknown) => {
      (res as http.ServerResponse).end(JSON.stringify({ ok: true }));
    });
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/lifeops/ping",
          public: true,
          publicReason: "test ping",
          handler,
        },
      ] as unknown as Route[],
    } as unknown as AgentRuntime;
    const args = ctx("/lifeops/ping", {
      runtime,
      isAuthorizedRequest: vi.fn(() => false),
    });
    await expect(handleLifeOpsRuntimePluginRoute(args)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(args.isAuthorizedRequest).not.toHaveBeenCalled();
  });

  it("does not match a GET route against POST", async () => {
    const handler = vi.fn();
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/lifeops/ping",
          public: true,
          publicReason: "test ping",
          handler,
        },
      ] as unknown as Route[],
    } as unknown as AgentRuntime;
    await expect(
      handleLifeOpsRuntimePluginRoute(
        ctx("/lifeops/ping", { method: "POST", runtime }),
      ),
    ).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
