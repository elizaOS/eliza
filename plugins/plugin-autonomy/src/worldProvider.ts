import { addHeader, createUniqueUuid } from '@elizaos/core';

import type { IAgentRuntime, Memory, Provider, UUID, State, ProviderResult } from '@elizaos/core';
import { OODALoopService } from './ooda-service';
import { AutonomousServiceType } from './types';

const AUTO_WORLD_SEED = 'autonomous_world_singleton';
const AUTO_ROOM_SEED = 'autonomous_room_singleton';

/**
 * Provider that gives information about the autonomous world and room setup
 */
export const autonomousWorldProvider: Provider = {
  name: 'AUTONOMOUS_WORLD',
  description: 'Information about the autonomous world and room setup',
  position: 50,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      // Get the WORLD_ID setting
      const worldId = runtime.getSetting('WORLD_ID') as UUID;
      const autonomousRoomId = createUniqueUuid(runtime, AUTO_ROOM_SEED);

      if (!worldId) {
        return {
          data: {
            worldId: null,
            roomId: autonomousRoomId,
            status: 'no_world_id',
          },
          values: {
            autonomousWorld:
              'No WORLD_ID configured - autonomous system may not be fully initialized.',
          },
          text: 'No WORLD_ID configured - autonomous system may not be fully initialized.',
        };
      }

      // Get world and room information
      let world = null;
      let room = null;

      try {
        if (typeof runtime.getWorld === 'function') {
          world = await runtime.getWorld(worldId);
        }
        if (typeof runtime.getRoom === 'function') {
          room = await runtime.getRoom(autonomousRoomId);
        }
      } catch (error) {
        console.error('Error in world provider:', error);
      }

      const worldInfo = world
        ? {
            id: world.id,
            name: world.name,
            serverId: world.serverId,
            agentId: world.agentId,
          }
        : null;

      const roomInfo = room
        ? {
            id: room.id,
            name: room.name,
            type: room.type,
            worldId: room.worldId,
            source: room.source,
          }
        : null;

      const statusText = [
        `# Autonomous World Status`,
        ``,
        `**World ID:** ${worldId}`,
        `**World Status:** ${world ? 'Found' : 'Not Found'}`,
        world ? `**World Name:** ${world.name}` : '',
        ``,
        `**Autonomous Room ID:** ${autonomousRoomId}`,
        `**Room Status:** ${room ? 'Found' : 'Not Found'}`,
        room ? `**Room Name:** ${room.name}` : '',
        room ? `**Room Type:** ${room.type}` : '',
        room ? `**Room World ID:** ${room.worldId}` : '',
        ``,
        `**Agent ID:** ${runtime.agentId}`,
        `**Character Name:** ${runtime.character.name}`,
      ]
        .filter(Boolean)
        .join('\n');

      const formattedText = addHeader('# Autonomous World Information', statusText);

      return {
        data: {
          worldId,
          worldInfo,
          roomId: autonomousRoomId,
          roomInfo,
          agentId: runtime.agentId,
          characterName: runtime.character.name,
          status: world && room ? 'ready' : 'incomplete',
        },
        values: {
          autonomousWorld: statusText,
          worldStatus: world ? 'ready' : 'missing',
          roomStatus: room ? 'ready' : 'missing',
        },
        text: formattedText,
      };
    } catch (error) {
      console.error('[AutonomousWorldProvider] Error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        data: {
          error: errorMessage,
          status: 'error',
        },
        values: {
          autonomousWorld: `Error retrieving autonomous world information: ${errorMessage}`,
        },
        text: `Error retrieving autonomous world information: ${errorMessage}`,
      };
    }
  },
};

export const worldProvider: Provider = {
  name: 'AUTONOMOUS_WORLD_CONTEXT',
  description: 'Provides dynamic context about the autonomous world and OODA loop state',
  dynamic: true,
  position: 1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      // Get the OODA service
      let oodaService: OODALoopService | null = null;

      if (typeof runtime.getService === 'function') {
        oodaService = runtime.getService(
          AutonomousServiceType.AUTONOMOUS
        ) as OODALoopService | null;
      }

      if (!oodaService) {
        return {
          text: 'Autonomous OODA loop service is not active.',
          values: {
            autonomousActive: false,
          },
        };
      }

      // Get current context from the service
      const context = (oodaService as any).currentContext;
      const goals = (oodaService as any).goals || [];

      if (!context) {
        return {
          text: 'OODA loop is running but no active context available.',
          values: {
            autonomousActive: true,
            oodaRunning: true,
            contextAvailable: false,
          },
        };
      }

      // Calculate key metrics
      const observationCount = context.observations?.length || 0;
      const recentObservations = context.observations?.slice(-3) || [];
      const actionCount = context.actions?.length || 0;
      const runningActions =
        context.actions?.filter((a: any) => a.status === 'running').length || 0;
      const errorCount = context.errors?.length || 0;

      // Build dynamic context text
      const contextParts = [
        `Current OODA Phase: ${context.phase}`,
        `Run ID: ${context.runId}`,
        `Active for: ${formatDuration(Date.now() - context.startTime)}`,
        '',
        'System Status:',
        `- ${observationCount} observations collected`,
        `- ${actionCount} actions executed (${runningActions} running)`,
        `- ${errorCount} errors encountered`,
      ];

      if (context.orientation?.resourceStatus) {
        const rs = context.orientation.resourceStatus;
        contextParts.push(
          '',
          'Resource Usage:',
          `- CPU: ${rs.cpu}%`,
          `- Memory: ${rs.memory}%`,
          `- Task Slots: ${rs.taskSlots.used}/${rs.taskSlots.total}`
        );
      }

      if (goals.length > 0) {
        contextParts.push('', 'Active Goals:');
        goals.forEach((goal: any) => {
          contextParts.push(
            `- ${goal.description} (Progress: ${(goal.progress * 100).toFixed(0)}%)`
          );
        });
      }

      if (recentObservations.length > 0) {
        contextParts.push('', 'Recent Observations:');
        recentObservations.forEach((obs: any) => {
          contextParts.push(
            `- ${obs.type} from ${obs.source} (relevance: ${(obs.relevance * 100).toFixed(0)}%)`
          );
        });
      }

      if (context.metrics) {
        const m = context.metrics;
        contextParts.push(
          '',
          'Performance Metrics:',
          `- Cycle Time: ${formatDuration(m.cycleTime)}`,
          `- Success Rate: ${(m.actionSuccessRate * 100).toFixed(1)}%`,
          `- Error Rate: ${(m.errorRate * 100).toFixed(1)}%`,
          `- Resource Efficiency: ${(m.resourceEfficiency * 100).toFixed(1)}%`
        );
      }

      return {
        text: contextParts.join('\n'),
        values: {
          autonomousActive: true,
          oodaRunning: true,
          currentPhase: context.phase,
          runId: context.runId,
          uptime: Date.now() - context.startTime,
          observationCount,
          actionCount,
          runningActions,
          errorCount,
          goals: goals.map((g: any) => ({
            description: g.description,
            progress: g.progress,
            priority: g.priority,
          })),
          resourceStatus: context.orientation?.resourceStatus,
          metrics: context.metrics,
          recentObservations,
          environmentalFactors: context.orientation?.environmentalFactors || [],
        },
        data: {
          fullContext: context,
        },
      };
    } catch (error) {
      console.error('Error in AUTONOMOUS_WORLD_CONTEXT provider:', error);
      return {
        text: 'Failed to retrieve autonomous world context.',
        values: {
          autonomousActive: false,
          error: (error as Error).message,
        },
      };
    }
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
