/**
 * Integration coverage for service-start truth on GET /api/health (#16309):
 * boots a real AgentRuntime (no database, no mocks around the runtime), and
 * proves a clean boot reports zero failed services and no reported errors,
 * while a plugin service whose start() throws is exposed as a failed service
 * type in the health payload instead of settling as a healthy boot.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { AgentRuntime as RealAgentRuntime, Service } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

function makeContext(runtime: AgentRuntime): {
  ctx: HealthRouteContext;
  responses: Array<{ data: unknown; status: number }>;
} {
  const responses: Array<{ data: unknown; status: number }> = [];
  const state = {
    runtime,
    config: { connectors: {} } as ElizaConfig,
    agentState: "running",
    agentName: "service-truth-agent",
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

class HealthyService extends Service {
  static override serviceType = "health-truth-good";
  capabilityDescription = "healthy test service";
  static override async start(runtime: IAgentRuntime): Promise<Service> {
    return new HealthyService(runtime);
  }
  async stop(): Promise<void> {}
}

class ExplodingService extends Service {
  static override serviceType = "health-truth-exploding";
  capabilityDescription = "service that fails to start";
  static override async start(): Promise<Service> {
    throw new Error("injected boot failure");
  }
  async stop(): Promise<void> {}
}

async function bootRuntime(): Promise<AgentRuntime> {
  const runtime = new RealAgentRuntime({ logLevel: "fatal" });
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

describe("GET /api/health service-start truth", () => {
  it("reports zero failed services and no reported errors on a clean boot", async () => {
    const runtime = await bootRuntime();
    try {
      await runtime.registerPlugin({
        name: "health-truth-clean",
        description: "clean boot fixture",
        services: [HealthyService],
      });
      await runtime.getServiceLoadPromise(HealthyService.serviceType);

      const { ctx, responses } = makeContext(runtime);
      await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

      expect(responses).toHaveLength(1);
      const data = responses[0].data as {
        services: { registered: number; failed: number; failedTypes: string[] };
      };
      expect(data.services.failed).toBe(0);
      expect(data.services.failedTypes).toEqual([]);
      expect(data.services.registered).toBeGreaterThanOrEqual(1);
      expect(
        runtime
          .getRecentReportedErrors()
          .filter((entry) => entry.scope === "AgentRuntime.serviceStart"),
      ).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it("exposes an injected service-start failure as a failed service type", async () => {
    const runtime = await bootRuntime();
    try {
      await runtime.registerPlugin({
        name: "health-truth-failing",
        description: "injected service failure fixture",
        services: [ExplodingService],
      });
      await expect(
        runtime.getServiceLoadPromise(ExplodingService.serviceType),
      ).rejects.toThrow();

      const { ctx, responses } = makeContext(runtime);
      await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

      expect(responses).toHaveLength(1);
      const data = responses[0].data as {
        services: { failed: number; failedTypes: string[] };
      };
      expect(data.services.failed).toBeGreaterThanOrEqual(1);
      expect(data.services.failedTypes).toContain(ExplodingService.serviceType);
      const reported = runtime
        .getRecentReportedErrors()
        .filter((entry) => entry.scope === "AgentRuntime.serviceStart");
      expect(reported.length).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.stop();
    }
  });
});
