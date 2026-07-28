/**
 * Drives service readiness through the real AgentRuntime and health route,
 * distinguishing boot-critical failures from optional degradation.
 */

import type http from "node:http";
import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  Service,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

const OPTIONAL_TYPE = "health_route_optional_failure";
const CRITICAL_TYPE = "health_route_critical_failure";

class OptionalFailureService extends Service {
  static override readonly serviceType = OPTIONAL_TYPE;
  override capabilityDescription =
    "Optional failure used by health integration.";
  static override async start(): Promise<OptionalFailureService> {
    throw new Error("optional startup failure");
  }
  override async stop(): Promise<void> {}
}

class CriticalFailureService extends Service {
  static override readonly serviceType = CRITICAL_TYPE;
  static override readonly bootCritical = true;
  override capabilityDescription =
    "Critical failure used by health integration.";
  static override async start(): Promise<CriticalFailureService> {
    throw new Error("critical startup failure");
  }
  override async stop(): Promise<void> {}
}

describe("service health route", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
      await runtime.close();
    }
  });

  async function failingRuntime(
    service: typeof OptionalFailureService | typeof CriticalFailureService,
  ): Promise<AgentRuntime> {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "HealthRouteServiceFailure" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();
    await runtime.registerPlugin({
      name: "health-route-service-failure-plugin",
      description: "Registers a failing health-route integration service.",
      services: [service],
    });
    await expect(
      runtime.getServiceLoadPromise(service.serviceType),
    ).rejects.toMatchObject({ code: "SERVICE_START_FAILED" });
    return runtime;
  }

  async function requestHealth(runtime: AgentRuntime) {
    const res = {} as http.ServerResponse;
    const json = vi.fn<HealthRouteContext["json"]>();
    await handleHealthRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: "/api/health",
      url: new URL("http://localhost/api/health"),
      state: {
        runtime,
        config: {},
        agentState: "running",
        agentName: "HealthRouteServiceFailure",
        model: undefined,
        startedAt: Date.now(),
        startup: { phase: "ready", attempt: 1 },
        plugins: [],
        pendingRestartReasons: [],
        connectorHealthMonitor: null,
      },
      json,
      error: vi.fn<HealthRouteContext["error"]>(),
    });
    return { json, res };
  }

  it("reports an optional service failure as ready but degraded", async () => {
    const runtime = await failingRuntime(OptionalFailureService);
    const { json, res } = await requestHealth(runtime);
    expect(json).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        ready: true,
        services: expect.objectContaining({
          status: "degraded",
          failed: 1,
          failures: [
            expect.objectContaining({
              serviceType: OPTIONAL_TYPE,
              serviceClass: "OptionalFailureService",
              critical: false,
              message: "optional startup failure",
            }),
          ],
        }),
      }),
      200,
    );
  });

  it("returns 503 when a boot-critical service fails", async () => {
    const runtime = await failingRuntime(CriticalFailureService);
    const { json, res } = await requestHealth(runtime);
    expect(json).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        ready: false,
        services: expect.objectContaining({
          status: "failed",
          failed: 1,
          failures: [
            expect.objectContaining({
              serviceType: CRITICAL_TYPE,
              serviceClass: "CriticalFailureService",
              critical: true,
              message: "critical startup failure",
            }),
          ],
        }),
      }),
      503,
    );
  });
});
