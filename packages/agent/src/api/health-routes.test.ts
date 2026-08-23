/**
 * Exercises the health, status, and runtime-introspection route dispatcher
 * against deterministic runtime objects. The suite drives the real handler
 * and observes its transport responses without starting an HTTP server.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  computeCanRespond,
  type HealthRouteContext,
  type HealthRouteState,
  handleHealthRoutes,
  parseDebugPositiveInt,
} from "./health-routes";

function makeRequest(remoteAddress = "127.0.0.1"): http.IncomingMessage {
  return {
    headers: { host: "127.0.0.1:3000" },
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function makeState(
  overrides: Partial<HealthRouteState> = {},
): HealthRouteState {
  return {
    runtime: null,
    config: {} as ElizaConfig,
    agentState: "running",
    agentName: "Eliza",
    model: undefined,
    startedAt: undefined,
    startup: { phase: "ready", attempt: 1 },
    plugins: [],
    pendingRestartReasons: [],
    connectorHealthMonitor: null,
    ...overrides,
  };
}

function makeContext(
  pathname: string,
  options: {
    method?: string;
    query?: string;
    request?: http.IncomingMessage;
    state?: HealthRouteState;
  } = {},
) {
  const json = vi.fn<HealthRouteContext["json"]>();
  const error = vi.fn<HealthRouteContext["error"]>();
  const req = options.request ?? makeRequest();
  const ctx: HealthRouteContext = {
    req,
    res: {} as http.ServerResponse,
    method: options.method ?? "GET",
    pathname,
    url: new URL(`http://127.0.0.1${pathname}${options.query ?? ""}`),
    state: options.state ?? makeState(),
    json,
    error,
  };
  return { ctx, json, error };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseDebugPositiveInt", () => {
  it("uses defaults, rejects malformed input, and clamps canonical bounds", () => {
    expect(parseDebugPositiveInt(null, 10, 1, 24)).toBe(10);
    expect(parseDebugPositiveInt("", 10, 1, 24)).toBe(10);
    expect(parseDebugPositiveInt("01", 10, 1, 24)).toBe("invalid");
    expect(parseDebugPositiveInt("0", 10, 1, 24)).toBe(1);
    expect(parseDebugPositiveInt("999", 10, 1, 24)).toBe(24);
    expect(parseDebugPositiveInt("12", 10, 1, 24)).toBe(12);
  });
});

describe("computeCanRespond", () => {
  it("requires a running runtime with a registered text-generation model", () => {
    const runtime = {
      getModel: (modelType: string) =>
        modelType === ModelType.TEXT_LARGE ? () => undefined : undefined,
    } as unknown as AgentRuntime;

    expect(computeCanRespond(null, "running")).toBe(false);
    expect(computeCanRespond(runtime, "starting")).toBe(false);
    expect(computeCanRespond(runtime, "running")).toBe(true);
    expect(
      computeCanRespond(
        { getModel: () => undefined } as unknown as AgentRuntime,
        "running",
      ),
    ).toBe(false);
  });

  it("degrades a throwing model registry to unavailable", () => {
    const runtime = {
      getModel: () => {
        throw new Error("model registry unavailable");
      },
    } as unknown as AgentRuntime;

    expect(computeCanRespond(runtime, "running")).toBe(false);
  });
});

describe("handleHealthRoutes dispatch", () => {
  it("does not claim unrelated paths or unsupported methods", async () => {
    const unrelated = makeContext("/api/unknown");
    const wrongMethod = makeContext("/api/health", { method: "POST" });

    await expect(handleHealthRoutes(unrelated.ctx)).resolves.toBe(false);
    await expect(handleHealthRoutes(wrongMethod.ctx)).resolves.toBe(false);
    expect(unrelated.json).not.toHaveBeenCalled();
    expect(unrelated.error).not.toHaveBeenCalled();
    expect(wrongMethod.json).not.toHaveBeenCalled();
    expect(wrongMethod.error).not.toHaveBeenCalled();
  });
});

describe("handleHealthRoutes GET /api/status", () => {
  it("reports the boot snapshot, uptime, restart state, and response readiness", async () => {
    const startedAt = Date.now() - 1_500;
    // `detectRuntimeModel` resolves the live provider first and only falls
    // back to `state.model`. Stub the receipt it reads first
    // (`getLastResolvedModelProvider`) so the reported label comes from the
    // runtime rather than from whichever provider API key happens to be in
    // the ambient environment -- without it this case only passes on a machine
    // with OPENAI_API_KEY set.
    const runtime = {
      getModel: (modelType: string) =>
        modelType === ModelType.TEXT_LARGE ? () => undefined : undefined,
      getLastResolvedModelProvider: () => "openai",
    } as unknown as AgentRuntime;
    const { ctx, json, error } = makeContext("/api/status", {
      state: makeState({
        runtime,
        model: "boot-model",
        startedAt,
        pendingRestartReasons: ["plugin configuration changed"],
      }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        model: "openai",
        canRespond: true,
        startedAt,
        pendingRestart: true,
        pendingRestartReasons: ["plugin configuration changed"],
        startup: { phase: "ready", attempt: 1 },
      }),
    );
    expect(body.uptime).toBeGreaterThanOrEqual(1_500);
    expect(body.cloud).toEqual(
      expect.objectContaining({
        connectionStatus: expect.stringMatching(/^(connected|disconnected)$/),
        cloudProvisioned: expect.any(Boolean),
        hasApiKey: expect.any(Boolean),
      }),
    );
  });
});

describe("handleHealthRoutes GET /api/health", () => {
  it("returns only readiness to an untrusted remote caller", async () => {
    const { ctx, json, error } = makeContext("/api/health", {
      request: makeRequest("203.0.113.9"),
      state: makeState({
        plugins: [
          { enabled: true, configured: true },
          { enabled: false, configured: true, loadError: "broken" },
        ],
      }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ready: true }, 200);
  });

  it("reports configured connectors and plugin counts without a runtime", async () => {
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "0");
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    const config = {
      connectors: {
        discord: { enabled: true },
        telegram: { enabled: false },
        slack: {},
      },
    } as unknown as ElizaConfig;
    const { ctx, json, error } = makeContext("/api/health", {
      state: makeState({
        config,
        startedAt: Date.now() - 2_500,
        plugins: [
          { enabled: true, configured: true },
          { enabled: false, configured: true, isActive: true },
          { enabled: false, configured: true, loadError: "failed import" },
        ],
      }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(json.mock.calls[0][2]).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        ready: true,
        canRespond: false,
        runtime: "not_initialized",
        database: "unknown",
        plugins: { loaded: 2, failed: 1 },
        services: { registered: 0, failed: 0, failedTypes: [] },
        coordinator: "not_wired",
        connectors: { discord: "configured", slack: "configured" },
        agentState: "running",
      }),
    );
    expect(body.uptime).toBeGreaterThanOrEqual(2);
    expect(body).toHaveProperty("deferredBoot");
  });

  it("returns 503, disables responses, and sorts failed services for a terminal database", async () => {
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "0");
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    const runtime = {
      plugins: [{ name: "one" }],
      adapter: {
        getRawConnection: () => ({
          query: async () => {
            throw new Error("PGlite is closed");
          },
        }),
      },
      getService: () => null,
      getServiceHealth: () => ({
        zeta: { status: "failed" },
        alpha: { status: "failed" },
        healthy: { status: "registered" },
      }),
      getModel: () => () => undefined,
    } as unknown as AgentRuntime;
    const monitor = {
      getConnectorStatuses: () => ({ discord: "missing" }),
    } as unknown as HealthRouteState["connectorHealthMonitor"];
    const { ctx, json } = makeContext("/api/health", {
      state: makeState({ runtime, connectorHealthMonitor: monitor }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(json.mock.calls[0][2]).toBe(503);
    expect(body).toEqual(
      expect.objectContaining({
        ready: false,
        canRespond: false,
        runtime: "ok",
        database: "terminal_error",
        plugins: { loaded: 1, failed: 0 },
        services: {
          registered: 1,
          failed: 2,
          failedTypes: ["alpha", "zeta"],
        },
        connectors: { discord: "missing" },
      }),
    );
    expect(body.databaseLiveness).toEqual(
      expect.objectContaining({
        status: "terminal_error",
        ok: false,
        terminal: true,
        message: "PGlite is closed",
      }),
    );
  });
});

describe("handleHealthRoutes GET /api/runtime", () => {
  it("returns a complete empty snapshot when the runtime is unavailable", async () => {
    const { ctx, json, error } = makeContext("/api/runtime");

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        runtimeAvailable: false,
        settings: {
          maxDepth: 10,
          maxArrayLength: 1000,
          maxObjectEntries: 1000,
          maxStringLength: 8000,
        },
        order: {
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: [],
        },
        sections: {
          runtime: null,
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: {},
        },
      }),
    );
  });

  it("rejects any malformed serialization query parameter", async () => {
    const { ctx, json, error } = makeContext("/api/runtime", {
      query:
        "?depth=4&maxArrayLength=01&maxObjectEntries=20&maxStringLength=128",
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "depth, maxArrayLength, maxObjectEntries, and maxStringLength must be canonical positive integers",
      400,
    );
  });

  it("preserves runtime ordering and safely serializes cycles, accessors, and bounded arrays", async () => {
    const cyclic: Record<string, unknown> = { label: "root" };
    cyclic.self = cyclic;
    const accessor = {};
    const getter = vi.fn(() => "must not execute");
    Object.defineProperty(accessor, "secret", {
      get: getter,
      enumerable: true,
    });
    const service = { id: "service-id" };
    const runtime = {
      agentId: "agent-id",
      character: { name: "Runtime Eliza" },
      plugins: [{ name: "plugin-one", cyclic }],
      actions: [{ name: "action-one" }, { key: "action-two" }],
      providers: [accessor],
      evaluators: [null],
      services: new Map([["database", [service]]]),
    } as unknown as AgentRuntime;
    const { ctx, json, error } = makeContext("/api/runtime", {
      query: "?depth=6&maxArrayLength=1&maxObjectEntries=20&maxStringLength=64",
      state: makeState({ runtime }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        runtimeAvailable: true,
        settings: {
          maxDepth: 6,
          maxArrayLength: 1,
          maxObjectEntries: 20,
          maxStringLength: 64,
        },
        meta: expect.objectContaining({
          agentId: "agent-id",
          agentName: "Runtime Eliza",
          pluginCount: 1,
          actionCount: 2,
          providerCount: 1,
          evaluatorCount: 1,
          serviceTypeCount: 1,
          serviceCount: 1,
        }),
        order: {
          plugins: [
            {
              index: 0,
              name: "plugin-one",
              className: "Object",
              id: "plugin-one",
            },
          ],
          actions: [
            {
              index: 0,
              name: "action-one",
              className: "Object",
              id: "action-one",
            },
            { index: 1, name: "action-two", className: "Object", id: null },
          ],
          providers: [
            { index: 0, name: "provider 1", className: "Object", id: null },
          ],
          evaluators: [
            { index: 0, name: "evaluator 1", className: "object", id: null },
          ],
          services: [
            {
              index: 0,
              serviceType: "database",
              count: 1,
              instances: [
                {
                  index: 0,
                  name: "service-id",
                  className: "Object",
                  id: "service-id",
                },
              ],
            },
          ],
        },
      }),
    );
    const sections = body.sections as Record<string, unknown>;
    expect(sections.actions).toEqual(
      expect.objectContaining({
        __type: "array",
        length: 2,
        truncatedItems: 1,
      }),
    );
    expect(JSON.stringify(sections.plugins)).toContain('"__type":"circular"');
    expect(JSON.stringify(sections.providers)).toContain('"__type":"accessor"');
  });

  it("reuses an identical runtime snapshot within the cache window", async () => {
    const runtime = {
      agentId: "agent-id",
      character: { name: "Eliza" },
      plugins: [],
      actions: [],
      providers: [],
      evaluators: [],
      services: new Map(),
    } as unknown as AgentRuntime;
    const first = makeContext("/api/runtime", {
      state: makeState({ runtime }),
    });
    const second = makeContext("/api/runtime", {
      state: makeState({ runtime }),
    });

    await handleHealthRoutes(first.ctx);
    await handleHealthRoutes(second.ctx);

    expect(second.json.mock.calls[0][1]).toBe(first.json.mock.calls[0][1]);
  });

  it("translates runtime snapshot failures into a 500 response", async () => {
    const runtime = {
      get services(): Map<string, unknown[]> {
        throw new Error("services unavailable");
      },
    } as unknown as AgentRuntime;
    const { ctx, json, error } = makeContext("/api/runtime", {
      state: makeState({ runtime }),
    });

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to build runtime debug snapshot: services unavailable",
      500,
    );
  });
});
