import type { IAgentRuntime, Route } from "@elizaos/core";

// Route handler request/response types (elizaos/core uses any in v1.6.5+)
type RouteRequest = { body?: unknown };
type RouteResponse = {
  status: (code: number) => RouteResponse;
  json: (data: unknown) => void;
};

import type { AutonomyService } from "./service";
import { AutonomousServiceType } from "./types";

// Type guard to check if service is AutonomyService
function isAutonomyService(service: unknown): service is AutonomyService {
  return (
    service !== null &&
    typeof service === "object" &&
    "getStatus" in service &&
    "enableAutonomy" in service &&
    "disableAutonomy" in service &&
    "setLoopInterval" in service &&
    typeof (service as { getStatus: unknown }).getStatus === "function"
  );
}

/**
 * Simple API routes for controlling autonomy via settings
 */
export const autonomyRoutes: Route[] = [
  {
    path: "/autonomy/status",
    type: "GET",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime,
    ) => {
      void req; // Request currently unused but kept for signature compatibility

      const autonomyService = runtime.getService(
        AutonomousServiceType.AUTONOMOUS,
      );

      if (!autonomyService || !isAutonomyService(autonomyService)) {
        res.status(503).json({
          error: "Autonomy service not available",
        });
        return;
      }

      const status = autonomyService.getStatus();

      res.json({
        success: true,
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
          autonomousRoomId: status.autonomousRoomId,
          agentId: runtime.agentId,
          characterName: runtime.character?.name || "Agent",
        },
      });
    },
  },

  {
    path: "/autonomy/enable",
    type: "POST",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime,
    ) => {
      void req; // Request currently unused but kept for signature compatibility

      const autonomyService = runtime.getService(
        AutonomousServiceType.AUTONOMOUS,
      );

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      if (!isAutonomyService(autonomyService)) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      await autonomyService.enableAutonomy();
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: "Autonomy enabled",
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
        },
      });
    },
  },

  {
    path: "/autonomy/disable",
    type: "POST",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime,
    ) => {
      void req; // Request currently unused but kept for signature compatibility

      const autonomyService = runtime.getService(
        AutonomousServiceType.AUTONOMOUS,
      );

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      if (!isAutonomyService(autonomyService)) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      await autonomyService.disableAutonomy();
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: "Autonomy disabled",
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
        },
      });
    },
  },

  {
    path: "/autonomy/toggle",
    type: "POST",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime,
    ) => {
      void req; // Request currently unused but kept for signature compatibility

      const autonomyService = runtime.getService(
        AutonomousServiceType.AUTONOMOUS,
      );

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      // Type guard to verify autonomyService is AutonomyService
      if (!isAutonomyService(autonomyService)) {
        res.status(503).json({
          success: false,
          error: "Autonomy service type mismatch",
        });
        return;
      }

      // TypeScript now knows autonomyService is AutonomyService after the guard
      const currentStatus = (autonomyService as AutonomyService).getStatus();

      if (currentStatus.enabled) {
        if (!isAutonomyService(autonomyService)) {
          res.status(503).json({
            success: false,
            error: "Autonomy service not available",
          });
          return;
        }

        await autonomyService.disableAutonomy();
      } else {
        // Type guard already verified autonomyService is AutonomyService
        await autonomyService.enableAutonomy();
      }

      // Type guard already verified autonomyService is AutonomyService
      const newStatus = autonomyService.getStatus();

      res.json({
        success: true,
        message: newStatus.enabled ? "Autonomy enabled" : "Autonomy disabled",
        data: {
          enabled: newStatus.enabled,
          running: newStatus.running,
          interval: newStatus.interval,
        },
      });
    },
  },

  {
    path: "/autonomy/interval",
    type: "POST",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime,
    ) => {
      const autonomyService = runtime.getService(
        AutonomousServiceType.AUTONOMOUS,
      );

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      const interval = (req.body as { interval?: unknown } | undefined)
        ?.interval;

      if (
        typeof interval !== "number" ||
        interval < 5000 ||
        interval > 600000
      ) {
        res.status(400).json({
          success: false,
          error:
            "Interval must be a number between 5000ms (5s) and 600000ms (10m)",
        });
        return;
      }

      if (!isAutonomyService(autonomyService)) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      autonomyService.setLoopInterval(interval);
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: "Interval updated",
        data: {
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
        },
      });
    },
  },
];
