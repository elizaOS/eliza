import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from '@elizaos/core';
import type { AutonomyService } from './service';
import { AutonomousServiceType } from './types';

/**
 * Autonomy Status Provider - shows autonomy status in regular conversations
 * Does NOT show in autonomous monologue loop to avoid unnecessary context
 */
export const autonomyStatusProvider: Provider = {
  name: 'AUTONOMY_STATUS',
  description:
    'Provides current autonomy status for agent awareness in conversations',

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    // Get autonomy service
    const autonomyService = runtime.getService<AutonomyService>(
      AutonomousServiceType.AUTONOMOUS
    );
    if (!autonomyService) {
      return { text: '', data: {} }; // Service not available, don't show status
    }

    // Check if we're in the autonomous room - if so, don't show status (avoid noise)
    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (autonomousRoomId && message.roomId === autonomousRoomId) {
      return { text: '', data: {} }; // Don't show in autonomous context
    }

    // Get autonomy settings and service status
    const autonomyEnabled = runtime.getSetting('AUTONOMY_ENABLED');
    const serviceRunning = autonomyService.isLoopRunning?.() ?? false;
    const interval = autonomyService.getLoopInterval?.() ?? 30000;

    // Determine status
    let status: string;
    let statusIcon: string;

    if (serviceRunning) {
      status = 'running autonomously';
      statusIcon = '🤖';
    } else if (autonomyEnabled) {
      status = 'autonomy enabled but not running';
      statusIcon = '⏸️';
    } else {
      status = 'autonomy disabled';
      statusIcon = '🔕';
    }

    const intervalSeconds = Math.round(interval / 1000);
    const intervalUnit =
      intervalSeconds < 60
        ? `${intervalSeconds} seconds`
        : `${Math.round(intervalSeconds / 60)} minutes`;

    return {
      text: `[AUTONOMY_STATUS]\nCurrent status: ${statusIcon} ${status}\nThinking interval: ${intervalUnit}\n[/AUTONOMY_STATUS]`,
      data: {
        autonomyEnabled: !!autonomyEnabled,
        serviceRunning,
        interval,
        intervalSeconds,
        status: serviceRunning
          ? 'running'
          : autonomyEnabled
            ? 'enabled'
            : 'disabled',
      },
    };
  },
};
