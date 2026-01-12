import type { IAgentRuntime, Route } from '@elizaos/core';
import type { AutonomyService } from './service';
import { AutonomousServiceType } from './types';

interface RouteRequest {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

interface RouteResponse {
  status: (code: number) => RouteResponse;
  json: (data: unknown) => unknown;
}

/**
 * Type guard to check if service is AutonomyService
 */
function isAutonomyService(service: unknown): service is AutonomyService {
  return (
    service !== null &&
    typeof service === 'object' &&
    'getStatus' in service &&
    'enableAutonomy' in service &&
    'disableAutonomy' in service &&
    'setLoopInterval' in service &&
    typeof (service as { getStatus: unknown }).getStatus === 'function'
  );
}

/**
 * Get autonomy service from runtime
 */
function getAutonomyService(runtime: IAgentRuntime): AutonomyService | null {
  const service = runtime.getService(AutonomousServiceType.AUTONOMOUS);
  if (service && isAutonomyService(service)) {
    return service;
  }
  return null;
}

/**
 * API routes for controlling autonomy via settings
 */
export const autonomyRoutes: Route[] = [
  {
    path: '/autonomy/status',
    type: 'GET',
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          error: 'Autonomy service not available',
        });
        return;
      }

      const status = autonomyService.getStatus();

      res.json({
        success: true,
        data: {
          enabled: status.enabled,
          running: status.running,
          thinking: status.thinking,
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
          autonomousRoomId: status.autonomousRoomId,
          agentId: runtime.agentId,
          characterName: runtime.character?.name || 'Agent',
        },
      });
    },
  },

  {
    path: '/autonomy/enable',
    type: 'POST',
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: 'Autonomy service not available',
        });
        return;
      }

      await autonomyService.enableAutonomy();
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: 'Autonomy enabled',
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
        },
      });
    },
  },

  {
    path: '/autonomy/disable',
    type: 'POST',
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: 'Autonomy service not available',
        });
        return;
      }

      await autonomyService.disableAutonomy();
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: 'Autonomy disabled',
        data: {
          enabled: status.enabled,
          running: status.running,
          interval: status.interval,
        },
      });
    },
  },

  {
    path: '/autonomy/toggle',
    type: 'POST',
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: 'Autonomy service not available',
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
        message: newStatus.enabled ? 'Autonomy enabled' : 'Autonomy disabled',
        data: {
          enabled: newStatus.enabled,
          running: newStatus.running,
          interval: newStatus.interval,
        },
      });
    },
  },

  {
    path: '/autonomy/interval',
    type: 'POST',
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ) => {
      const autonomyService = getAutonomyService(runtime);

      if (!autonomyService) {
        res.status(503).json({
          success: false,
          error: 'Autonomy service not available',
        });
        return;
      }

      const { interval } = req.body as { interval?: number };

      if (
        typeof interval !== 'number' ||
        interval < 5000 ||
        interval > 600000
      ) {
        res.status(400).json({
          success: false,
          error:
            'Interval must be a number between 5000ms (5s) and 600000ms (10m)',
        });
        return;
      }

      autonomyService.setLoopInterval(interval);
      const status = autonomyService.getStatus();

      res.json({
        success: true,
        message: 'Interval updated',
        data: {
          interval: status.interval,
          intervalSeconds: Math.round(status.interval / 1000),
        },
      });
    },
  },
];
