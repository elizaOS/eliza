import {
  type ActionResult,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';
import { getTunnelService } from '../types';

export async function handleStopTunnel(
  runtime: IAgentRuntime,
  _message?: Memory,
  _state?: State,
  _options?: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  if (!tunnelService) {
    if (callback) {
      await callback({ text: 'Tunnel service is not available.' });
    }
    return { success: false, error: 'tunnel service unavailable' };
  }

  if (!tunnelService.isActive()) {
    elizaLogger.warn('[stop-tunnel] no active tunnel to stop');
    if (callback) {
      await callback({ text: 'No tunnel is currently running.' });
    }
    return {
      success: true,
      text: 'no active tunnel',
      data: { action: 'tunnel_not_active' },
    };
  }

  const status = tunnelService.getStatus();
  const previousUrl = status.url;
  const previousPort = status.port;

  await tunnelService.stopTunnel();

  if (callback) {
    await callback({
      text: `Tunnel stopped.\n\nWas running on port: ${previousPort}\nPrevious URL: ${previousUrl}`,
    });
  }
  return {
    success: true,
    text: `Tunnel stopped (was on port ${previousPort})`,
    data: {
      action: 'tunnel_stopped',
      previousUrl: previousUrl ?? '',
      previousPort: previousPort ?? 0,
    },
  };
}
