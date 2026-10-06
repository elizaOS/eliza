import type { Route, RouteHandler } from "@elizaos/host/protocol";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service.ts";

function autonomyRoute(
  path: string,
  type: "GET" | "POST",
  handle: (
    service: AutonomyService,
    context: Parameters<RouteHandler>[0],
  ) => ReturnType<RouteHandler>,
): Route {
  return {
    path: `/autonomy/${path}`,
    type,
    routeHandler: async (context) => {
      const service = context.runtime.getService<AutonomyService>(
        AUTONOMY_SERVICE_TYPE,
      );
      if (!service)
        return {
          status: 503,
          body: {
            ...(type === "POST" ? { success: false } : {}),
            error: "Autonomy service not available",
          },
        };
      return handle(service, context);
    },
  };
}

export const autonomyRoutes: Route[] = [
  autonomyRoute("status", "GET", async (service, { runtime }) => {
    const status = service.getStatus();
    return {
      status: 200,
      body: {
        success: true,
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
          autonomousRoomId: status.autonomousRoomId,
          agentId: runtime.agentId,
          characterName: runtime.character.name || "Agent",
        },
      },
    };
  }),
  ...(["enable", "disable", "toggle"] as const).map((operation) =>
    autonomyRoute(operation, "POST", async (service) => {
      const enable =
        operation === "toggle"
          ? !service.getStatus().enabled
          : operation === "enable";
      if (enable) await service.enableAutonomy();
      else await service.disableAutonomy();
      const { enabled, running, interval } = service.getStatus();
      return {
        status: 200,
        body: {
          success: true,
          message: enabled ? "Autonomy enabled" : "Autonomy disabled",
          data: { enabled, running, interval },
        },
      };
    }),
  ),
  autonomyRoute("interval", "POST", async (service, { body }) => {
    const interval =
      body && typeof body === "object" && !Array.isArray(body)
        ? Reflect.get(body, "interval")
        : undefined;
    if (
      typeof interval !== "number" ||
      !Number.isFinite(interval) ||
      interval < 5000 ||
      interval > 600000
    )
      return {
        status: 400,
        body: {
          success: false,
          error:
            "Interval must be a number between 5000ms (5s) and 600000ms (10m)",
        },
      };
    await service.setLoopInterval(interval);
    const status = service.getStatus();
    return {
      status: 200,
      body: {
        success: true,
        message: "Interval updated",
        data: {
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
        },
      },
    };
  }),
];
