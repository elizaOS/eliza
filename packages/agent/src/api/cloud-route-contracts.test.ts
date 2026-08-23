/**
 * Pins the agent-side cloud route TypeScript contracts: proxy/billing, full
 * cloud, relay, and status handler signatures plus the state shapes they
 * dispatch through. The module is types-only — these tests lock the exported
 * relationships and drive real handler implementations against them (handled
 * vs not-handled, optional relay runtime, optional getSetting, extra
 * RouteState fields). No live cloud plugin.
 */
import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import type {
  AgentCloudBillingRouteHandler,
  AgentCloudCompatRouteHandler,
  AgentCloudProxyRouteState,
  AgentCloudRelayRouteHandler,
  AgentCloudRelayRouteState,
  AgentCloudRouteHandler,
  AgentCloudRouteState,
  AgentCloudStatusRouteContext,
  AgentCloudStatusRouteHandler,
} from "./cloud-route-contracts.ts";
import * as cloudRouteContracts from "./cloud-route-contracts.ts";
import type { ServerState } from "./server-types.ts";

const req = {} as http.IncomingMessage;
const res = {} as http.ServerResponse;

function proxyState(
  overrides: Partial<AgentCloudProxyRouteState> = {},
): AgentCloudProxyRouteState {
  return {
    config: {} as ServerState["config"],
    runtime: null,
    ...overrides,
  };
}

function routeState(
  overrides: Partial<AgentCloudRouteState> = {},
): AgentCloudRouteState {
  return {
    ...proxyState(),
    cloudManager: null,
    saveConfig: () => undefined,
    createTelemetrySpan: ((_meta, _options) => ({
      success: () => undefined,
      failure: () => undefined,
    })) as typeof createIntegrationTelemetrySpan,
    restartRuntime: async () => true,
    ...overrides,
  };
}

function helpers(overrides: Partial<RouteHelpers> = {}): RouteHelpers {
  return {
    json: () => undefined,
    error: () => undefined,
    readJsonBody: async () => null,
    ...overrides,
  };
}

describe("cloud-route-contracts", () => {
  it("is types-only: none of the exported contracts exist at runtime", () => {
    expect(Object.keys(cloudRouteContracts)).toEqual([]);
    expect("AgentCloudProxyRouteState" in cloudRouteContracts).toBe(false);
    expect("AgentCloudRouteState" in cloudRouteContracts).toBe(false);
    expect("AgentCloudRelayRouteState" in cloudRouteContracts).toBe(false);
    expect("AgentCloudStatusRouteContext" in cloudRouteContracts).toBe(false);
    expect("AgentCloudBillingRouteHandler" in cloudRouteContracts).toBe(false);
    expect("AgentCloudCompatRouteHandler" in cloudRouteContracts).toBe(false);
    expect("AgentCloudRelayRouteHandler" in cloudRouteContracts).toBe(false);
    expect("AgentCloudRouteHandler" in cloudRouteContracts).toBe(false);
    expect("AgentCloudStatusRouteHandler" in cloudRouteContracts).toBe(false);
  });
});

describe("billing and compat handler signatures", () => {
  it("aliases AgentCloudCompatRouteHandler to the billing handler", () => {
    expectTypeOf<AgentCloudCompatRouteHandler>().toEqualTypeOf<AgentCloudBillingRouteHandler>();
    expectTypeOf<Parameters<AgentCloudBillingRouteHandler>>().toEqualTypeOf<
      [
        http.IncomingMessage,
        http.ServerResponse,
        string,
        string,
        AgentCloudProxyRouteState,
      ]
    >();
    expectTypeOf<ReturnType<AgentCloudBillingRouteHandler>>().toEqualTypeOf<
      Promise<boolean>
    >();
  });

  it("returns true when a billing handler claims the request", async () => {
    const billing: AgentCloudBillingRouteHandler = async (
      _req,
      _res,
      pathname,
      method,
      state,
    ) => {
      return (
        method === "GET" &&
        pathname === "/api/cloud/billing" &&
        state.runtime === null
      );
    };
    const compat: AgentCloudCompatRouteHandler = billing;

    await expect(
      billing(req, res, "/api/cloud/billing", "GET", proxyState()),
    ).resolves.toBe(true);
    await expect(
      compat(req, res, "/api/cloud/billing", "GET", proxyState()),
    ).resolves.toBe(true);
  });

  it("returns false when billing does not handle the path or method", async () => {
    const billing: AgentCloudBillingRouteHandler = async (
      _req,
      _res,
      pathname,
      method,
    ) => method === "GET" && pathname === "/api/cloud/billing";

    await expect(
      billing(req, res, "/api/cloud/billing", "POST", proxyState()),
    ).resolves.toBe(false);
    await expect(
      billing(req, res, "/api/other", "GET", proxyState()),
    ).resolves.toBe(false);
  });

  it("accepts full cloud route state where a proxy state is required", async () => {
    const seen: AgentCloudProxyRouteState[] = [];
    const billing: AgentCloudBillingRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
    ) => {
      seen.push(state);
      return true;
    };
    const full = routeState();

    await expect(
      billing(req, res, "/api/cloud/billing", "GET", full),
    ).resolves.toBe(true);
    expect(seen).toEqual([full]);
  });
});

describe("full cloud route handler and state", () => {
  it("requires the extra RouteState fields on top of the proxy shape", () => {
    expectTypeOf<AgentCloudRouteState>().toMatchTypeOf<AgentCloudProxyRouteState>();
    expectTypeOf<AgentCloudProxyRouteState>().not.toMatchTypeOf<AgentCloudRouteState>();
    expectTypeOf<
      Parameters<AgentCloudRouteHandler>[4]
    >().toEqualTypeOf<AgentCloudRouteState>();
    expectTypeOf<AgentCloudRouteState["saveConfig"]>().toEqualTypeOf<
      (config: ServerState["config"]) => void
    >();
    expectTypeOf<AgentCloudRouteState["restartRuntime"]>().toEqualTypeOf<
      (reason: string) => Promise<boolean>
    >();
    expectTypeOf<AgentCloudRouteState["createTelemetrySpan"]>().toEqualTypeOf<
      typeof createIntegrationTelemetrySpan
    >();
  });

  it("threads saveConfig, restartRuntime, and a telemetry span through the handler", async () => {
    const saved: ServerState["config"][] = [];
    const restarts: string[] = [];
    const spans: string[] = [];
    const config = {
      siteUrl: "https://cloud.example",
    } as ServerState["config"];
    const handler: AgentCloudRouteHandler = async (
      _req,
      _res,
      pathname,
      _method,
      state,
    ) => {
      if (pathname !== "/api/cloud") {
        return false;
      }
      const span = state.createTelemetrySpan({
        boundary: "cloud",
        operation: "route",
      });
      span.success();
      state.saveConfig(config);
      return state.restartRuntime("cloud-route");
    };

    const state = routeState({
      saveConfig: (next) => {
        saved.push(next);
      },
      restartRuntime: async (reason) => {
        restarts.push(reason);
        return true;
      },
      createTelemetrySpan: ((meta, _options) => {
        spans.push(meta.operation);
        return {
          success: () => {
            spans.push("success");
          },
          failure: () => {
            spans.push("failed");
          },
        };
      }) as typeof createIntegrationTelemetrySpan,
    });

    await expect(handler(req, res, "/api/other", "GET", state)).resolves.toBe(
      false,
    );
    expect(saved).toEqual([]);
    expect(restarts).toEqual([]);
    expect(spans).toEqual([]);

    await expect(handler(req, res, "/api/cloud", "POST", state)).resolves.toBe(
      true,
    );
    expect(saved).toEqual([config]);
    expect(restarts).toEqual(["cloud-route"]);
    expect(spans).toEqual(["route", "success"]);
  });

  it("propagates a failed restartRuntime result as not-handled", async () => {
    const handler: AgentCloudRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
    ) => state.restartRuntime("overflow");

    await expect(
      handler(
        req,
        res,
        "/api/cloud",
        "POST",
        routeState({ restartRuntime: async () => false }),
      ),
    ).resolves.toBe(false);
  });
});

describe("relay route handler and state", () => {
  it("takes RouteHelpers as a sixth argument and optional runtime state", () => {
    expectTypeOf<Parameters<AgentCloudRelayRouteHandler>>().toEqualTypeOf<
      [
        http.IncomingMessage,
        http.ServerResponse,
        string,
        string,
        AgentCloudRelayRouteState,
        RouteHelpers,
      ]
    >();
    expectTypeOf<AgentCloudRelayRouteState["runtime"]>().toEqualTypeOf<
      | {
          getService(type: string): unknown;
          getSetting?: (key: string) => string | number | boolean | null;
        }
      | undefined
    >();
  });

  it("handles an empty relay state with no runtime", async () => {
    const seen: unknown[] = [];
    const handler: AgentCloudRelayRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
      routeHelpers,
    ) => {
      seen.push(state.runtime);
      routeHelpers.error(res, "no-runtime", 503);
      return false;
    };
    const errors: Array<{ message: string; status?: number }> = [];

    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        {},
        helpers({
          error: (_res, message, status) => {
            errors.push({ message, status });
          },
        }),
      ),
    ).resolves.toBe(false);
    expect(seen).toEqual([undefined]);
    expect(errors).toEqual([{ message: "no-runtime", status: 503 }]);
  });

  it("reads getService when runtime is present without getSetting", async () => {
    const handler: AgentCloudRelayRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
    ) => {
      expect(state.runtime?.getSetting).toBeUndefined();
      return state.runtime?.getService("elizacloud") === "svc";
    };
    const state: AgentCloudRelayRouteState = {
      runtime: {
        getService: (type) => (type === "elizacloud" ? "svc" : null),
      },
    };

    await expect(
      handler(req, res, "/api/cloud/relay", "GET", state, helpers()),
    ).resolves.toBe(true);
    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        {
          runtime: {
            getService: () => null,
          },
        },
        helpers(),
      ),
    ).resolves.toBe(false);
  });

  it("accepts getSetting returning string, number, boolean, or null", async () => {
    const values: Array<string | number | boolean | null> = [];
    const handler: AgentCloudRelayRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
    ) => {
      const setting = state.runtime?.getSetting?.("ELIZA_CLOUD") ?? null;
      values.push(setting);
      return setting !== null;
    };

    const withSetting = (
      getSetting: (key: string) => string | number | boolean | null,
    ): AgentCloudRelayRouteState => ({
      runtime: {
        getService: () => undefined,
        getSetting,
      },
    });

    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        withSetting((key) => (key === "ELIZA_CLOUD" ? "on" : null)),
        helpers(),
      ),
    ).resolves.toBe(true);
    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        withSetting(() => 7),
        helpers(),
      ),
    ).resolves.toBe(true);
    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        withSetting(() => false),
        helpers(),
      ),
    ).resolves.toBe(true);
    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        withSetting(() => null),
        helpers(),
      ),
    ).resolves.toBe(false);

    expect(values).toEqual(["on", 7, false, null]);
  });

  it("looks up a missing setting key as null rather than throwing", async () => {
    const handler: AgentCloudRelayRouteHandler = async (
      _req,
      _res,
      _pathname,
      _method,
      state,
    ) => {
      const setting = state.runtime?.getSetting?.("missing") ?? null;
      return setting === null;
    };

    await expect(
      handler(
        req,
        res,
        "/api/cloud/relay",
        "GET",
        {
          runtime: {
            getService: () => undefined,
            getSetting: (key) => (key === "present" ? "yes" : null),
          },
        },
        helpers(),
      ),
    ).resolves.toBe(true);
  });
});

describe("status route handler and context", () => {
  it("takes a single context argument rather than positional params", () => {
    expectTypeOf<Parameters<AgentCloudStatusRouteHandler>>().toEqualTypeOf<
      [AgentCloudStatusRouteContext]
    >();
    expectTypeOf<AgentCloudStatusRouteContext["json"]>().toEqualTypeOf<
      RouteHelpers["json"]
    >();
    expectTypeOf<
      AgentCloudStatusRouteContext["method"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      AgentCloudStatusRouteContext["pathname"]
    >().toEqualTypeOf<string>();
  });

  it("handles GET /api/cloud/status and ignores other methods", async () => {
    const bodies: unknown[] = [];
    const handler: AgentCloudStatusRouteHandler = async (ctx) => {
      if (ctx.method !== "GET" || ctx.pathname !== "/api/cloud/status") {
        return false;
      }
      ctx.json(ctx.res, { ok: true, agent: ctx.runtime === null }, 200);
      return true;
    };
    const ctx: AgentCloudStatusRouteContext = {
      res,
      method: "GET",
      pathname: "/api/cloud/status",
      config: {} as ServerState["config"],
      runtime: null,
      json: (_res, data) => {
        bodies.push(data);
      },
    };

    await expect(handler(ctx)).resolves.toBe(true);
    expect(bodies).toEqual([{ ok: true, agent: true }]);

    await expect(handler({ ...ctx, method: "POST" })).resolves.toBe(false);
    await expect(
      handler({ ...ctx, pathname: "/api/cloud/other" }),
    ).resolves.toBe(false);
    expect(bodies).toEqual([{ ok: true, agent: true }]);
  });
});
