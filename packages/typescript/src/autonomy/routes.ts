/**
 * Autonomy Routes for elizaOS
 *
 * API routes for controlling autonomy via REST.
 */

import type { Route } from "../types";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service";

/**
 * Get autonomy service from runtime with fallback
 */
function getAutonomyService(runtime: {
  getService: (name: string) => AutonomyService | null;
}): AutonomyService | null {
  return (
    runtime.getService(AUTONOMY_SERVICE_TYPE) || runtime.getService("autonomy")
  );
}

/**
 * Autonomy API routes
 */
export const autonomyRoutes: Route[] = [
  {
    path: "/autonomy/status",
    type: "GET",
    handler: async (_req, res, runtime): Promise<void> => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
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
    handler: async (_req, res, runtime): Promise<void> => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
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
    handler: async (_req, res, runtime): Promise<void> => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
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
    handler: async (_req, res, runtime): Promise<void> => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      const currentStatus = autonomyService.getStatus();

      if (currentStatus.enabled) {
        await autonomyService.disableAutonomy();
      } else {
        await autonomyService.enableAutonomy();
      }

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
    handler: async (req, res, runtime): Promise<void> => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: "Autonomy service not available",
        });
        return;
      }

      const { interval } = req.body as { interval?: number };

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
