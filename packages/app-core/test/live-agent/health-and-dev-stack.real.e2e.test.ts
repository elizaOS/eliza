/**
 * Keyless real-runtime HTTP coverage for the health / status / runtime
 * introspection routes and the loopback dev-observability routes.
 *
 * Boots a REAL AgentRuntime (PGLite-backed) + the REAL app-core HTTP stack on
 * an ephemeral port via {@link startLiveRuntimeServer} (skipDeferredStartupWork),
 * then drives the routes over real HTTP on 127.0.0.1. No provider keys: the
 * routes asserted here do not call a model, so no LLM proxy is needed.
 *
 * Loopback requests are trusted (no ELIZA_API_TOKEN / cloud-provisioned env), so
 * `/api/dev/stack` and `/api/dev/route-catalog` (loopback-only + authorized)
 * answer without credentials.
 *
 * Routes + schema grounded in:
 *   - GET /api/health     packages/agent/src/api/health-routes.ts:508
 *   - GET /api/status     packages/agent/src/api/health-routes.ts:459
 *   - GET /api/runtime    packages/agent/src/api/health-routes.ts:565
 *   - GET /api/dev/stack          packages/app-core/src/api/dev-compat-routes.ts:49
 *                                 + packages/app-core/src/api/dev-stack.ts:53
 *   - GET /api/dev/route-catalog  packages/app-core/src/api/dev-compat-routes.ts:68
 *                                 + packages/app-core/src/api/dev-route-catalog.ts:466
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION } from "../../src/api/dev-route-catalog.ts";
import { ELIZA_DEV_STACK_SCHEMA } from "../../src/api/dev-stack.ts";
import { req } from "../helpers/http.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

describe("health + dev-stack real route coverage", () => {
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "health-dev-stack-",
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  function port(): number {
    if (!harness) {
      throw new Error("Live runtime harness was not started");
    }
    return harness.port;
  }

  it("GET /api/health reports ready with a loaded runtime and no failed plugins", async () => {
    const { status, data } = await req(port(), "GET", "/api/health");
    expect(status).toBe(200);
    expect(data.ready).toBe(true);
    expect(data.runtime).toBe("ok");
    expect(data.database).toBe("ok");

    const plugins = data.plugins as { loaded: number; failed: number };
    expect(typeof plugins.loaded).toBe("number");
    expect(plugins.loaded).toBeGreaterThan(0);
    expect(plugins.failed).toBe(0);

    expect(typeof data.uptime).toBe("number");
    expect(typeof data.agentState).toBe("string");
  });

  it("GET /api/status reports the agent name and a real state", async () => {
    const { status, data } = await req(port(), "GET", "/api/status");
    expect(status).toBe(200);
    expect(typeof data.state).toBe("string");
    expect((data.state as string).length).toBeGreaterThan(0);
    expect(typeof data.agentName).toBe("string");

    const cloud = data.cloud as {
      cloudProvisioned: boolean;
      hasApiKey: boolean;
    };
    expect(cloud.cloudProvisioned).toBe(false);
    expect(cloud.hasApiKey).toBe(false);
    expect(data.pendingRestart).toBe(false);
  });

  it("GET /api/runtime returns a deep snapshot of the live runtime graph", async () => {
    const { status, data } = await req(port(), "GET", "/api/runtime");
    expect(status).toBe(200);
    expect(data.runtimeAvailable).toBe(true);
    expect(typeof data.generatedAt).toBe("number");

    const meta = data.meta as {
      pluginCount: number;
      serviceCount: number;
      agentName: string;
    };
    expect(meta.pluginCount).toBeGreaterThan(0);
    expect(meta.serviceCount).toBeGreaterThan(0);
    expect(typeof meta.agentName).toBe("string");

    const order = data.order as { plugins: unknown[]; services: unknown[] };
    expect(Array.isArray(order.plugins)).toBe(true);
    expect(order.plugins.length).toBeGreaterThan(0);
    expect(Array.isArray(order.services)).toBe(true);
  });

  it("GET /api/dev/stack returns the schema-tagged loopback discovery payload", async () => {
    const { status, data } = await req(port(), "GET", "/api/dev/stack");
    expect(status).toBe(200);
    expect(data.schema).toBe(ELIZA_DEV_STACK_SCHEMA);

    const api = data.api as { listenPort: number; baseUrl: string };
    // The handler overrides listenPort/baseUrl from the bound socket, so the
    // reported port must be the real ephemeral port we connected to.
    expect(api.listenPort).toBe(port());
    expect(api.baseUrl).toBe(`http://127.0.0.1:${port()}`);

    const desktop = data.desktop as Record<string, unknown>;
    expect("rendererUrl" in desktop).toBe(true);
    expect("uiPort" in desktop).toBe(true);
    expect("desktopApiBase" in desktop).toBe(true);

    expect(Array.isArray(data.hints)).toBe(true);
    expect((data.hints as unknown[]).length).toBeGreaterThan(0);
  });

  it("GET /api/dev/route-catalog returns the versioned, non-empty route catalog", async () => {
    const { status, data } = await req(port(), "GET", "/api/dev/route-catalog");
    expect(status).toBe(200);
    expect(data.schemaVersion).toBe(ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION);
    expect(typeof data.generatedAt).toBe("string");

    const routes = data.routes as Array<{
      tabId: string;
      path: string;
      label: string;
    }>;
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
    // Every entry carries the documented shape.
    for (const route of routes) {
      expect(typeof route.tabId).toBe("string");
      expect(typeof route.path).toBe("string");
      expect(typeof route.label).toBe("string");
    }
    // The chat tab is always present in the catalog.
    expect(routes.some((route) => route.tabId === "chat")).toBe(true);

    expect(Array.isArray(data.settingsSections)).toBe(true);
    expect((data.settingsSections as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(data.modals)).toBe(true);
  });
});
