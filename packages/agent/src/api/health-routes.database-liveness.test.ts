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
      req: {} as HealthRouteContext["req"],
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
});
