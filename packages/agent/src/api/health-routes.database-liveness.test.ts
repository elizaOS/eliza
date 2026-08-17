/**
 * Real-PGlite health-route regression coverage for closed embedded databases.
 * The route must exercise the database, not just cached adapter state, because
 * Docker and cloud supervisors consume this signal to decide whether a running
 * agent needs recovery.
 */

import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

function makeContext(runtime: AgentRuntime | null): {
  ctx: HealthRouteContext;
  responses: Array<{ data: unknown; status: number }>;
} {
  const responses: Array<{ data: unknown; status: number }> = [];
  const state = {
    runtime,
    config: { connectors: {} } as ElizaConfig,
    agentState: "running",
    agentName: "test-agent",
    model: undefined,
    startedAt: Date.now(),
    startup: { phase: "ready", attempt: 1 },
    plugins: [],
    pendingRestartReasons: [],
    connectorHealthMonitor: null,
  };
  return {
    responses,
    ctx: {
      // Trusted-local shape: the /api/health detail payload is only served to
      // callers that pass the trusted-local check (W1-039).
      req: {
        headers: { host: "127.0.0.1" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as HealthRouteContext["req"],
      res: {} as HealthRouteContext["res"],
      method: "GET",
      pathname: "/api/health",
      url: new URL("http://127.0.0.1/api/health"),
      state,
      json: (_res, data, status = 200) => {
        responses.push({ data, status });
      },
      error: (_res, message, status = 500) => {
        responses.push({ data: { error: message }, status });
      },
    },
  };
}

describe("GET /api/health database liveness", () => {
  let pglite: PGlite | null = null;

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
      pglite = null;
    }
  });

  it("turns red after a real PGlite database is closed post-boot", async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    const runtime = {
      adapter: { getRawConnection: () => pglite },
      plugins: [],
      getModel: () => undefined,
      getServiceHealth: () => ({}),
    } as unknown as AgentRuntime;

    const green = makeContext(runtime);
    await expect(handleHealthRoutes(green.ctx)).resolves.toBe(true);
    expect(green.responses).toHaveLength(1);
    expect(green.responses[0].status).toBe(200);
    expect(green.responses[0].data).toMatchObject({
      ready: true,
      database: "ok",
      databaseLiveness: { ok: true, status: "ok", terminal: false },
    });

    await pglite.close();

    const red = makeContext(runtime);
    await expect(handleHealthRoutes(red.ctx)).resolves.toBe(true);
    expect(red.responses).toHaveLength(1);
    expect(red.responses[0].status).toBe(503);
    expect(red.responses[0].data).toMatchObject({
      ready: false,
      canRespond: false,
      database: "terminal_error",
      databaseLiveness: { ok: false, status: "terminal_error", terminal: true },
    });
    pglite = null;
  });

  it("distinguishes transient database errors from terminal liveness failures", async () => {
    const runtime = {
      adapter: {
        getRawConnection: () => ({
          async query() {
            throw new Error("temporary network timeout");
          },
        }),
      },
      plugins: [{ name: "sql" }],
      getModel: () => undefined,
      getServiceHealth: () => ({}),
    } as unknown as AgentRuntime;

    const transient = makeContext(runtime);
    await expect(handleHealthRoutes(transient.ctx)).resolves.toBe(true);

    expect(transient.responses[0].status).toBe(200);
    expect(transient.responses[0].data).toMatchObject({
      ready: true,
      database: "transient_error",
      databaseLiveness: {
        ok: false,
        status: "transient_error",
        terminal: false,
        message: "temporary network timeout",
      },
    });
  });

  it("returns non-ready health without a runtime and includes configured connectors", async () => {
    const { ctx, responses } = makeContext(null);
    ctx.state.config = {
      connectors: {
        discord: { enabled: true },
        slack: { enabled: false },
      },
    } as unknown as ElizaConfig;
    ctx.state.agentState = "starting";
    ctx.state.plugins = [
      { enabled: true, configured: true },
      { enabled: false, configured: true, loadError: "boom" },
    ];

    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses[0].status).toBe(200);
    expect(responses[0].data).toMatchObject({
      ready: false,
      canRespond: false,
      runtime: "not_initialized",
      database: "unknown",
      plugins: { loaded: 1, failed: 1 },
      connectors: { discord: "configured" },
      databaseLiveness: { ok: false, status: "unknown", terminal: false },
    });
  });

  it("serves status and runtime introspection without treating optional health as fatal", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const runtime = {
      agentId: "agent-id",
      character: { name: "Debug Agent" },
      plugins: [{ name: "plugin-a" }, { id: "plugin-b" }],
      actions: [{ name: "act" }],
      providers: [{ serviceType: "provider-kind" }],
      evaluators: [() => undefined],
      services: new Map([
        [
          "runtime",
          [
            circular,
            new Map([["k", { nested: true }]]),
            new Set(["a", "b"]),
            Buffer.from("abcdef"),
            new Error("diagnostic"),
          ],
        ],
      ]),
      getModel: () => undefined,
      adapter: {
        getRawConnection: () => ({
          async query() {
            return [{ "?column?": 1 }];
          },
        }),
      },
    } as unknown as AgentRuntime;

    const status = makeContext(runtime);
    status.ctx.pathname = "/api/status";
    await expect(handleHealthRoutes(status.ctx)).resolves.toBe(true);
    expect(status.responses[0].data).toMatchObject({
      state: "running",
      agentName: "test-agent",
      cloud: {
        connectionStatus: "disconnected",
        cloudProvisioned: false,
        hasApiKey: false,
      },
    });

    const debug = makeContext(runtime);
    debug.ctx.pathname = "/api/runtime";
    debug.ctx.url = new URL(
      "http://127.0.0.1/api/runtime?depth=5&maxArrayLength=3&maxObjectEntries=10&maxStringLength=64",
    );
    await expect(handleHealthRoutes(debug.ctx)).resolves.toBe(true);

    expect(debug.responses[0].data).toMatchObject({
      runtimeAvailable: true,
      meta: {
        agentId: "agent-id",
        agentName: "Debug Agent",
        pluginCount: 2,
        actionCount: 1,
        providerCount: 1,
        evaluatorCount: 1,
        serviceTypeCount: 1,
        serviceCount: 5,
      },
    });
    expect(debug.responses[0].data).toHaveProperty("sections.runtime");
  });
});
