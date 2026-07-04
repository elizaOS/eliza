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

  try {
    await tunnelService.stopTunnel();
  } catch (error) {
    // The tunnel service failed to tear down (e.g. `tailscale serve reset`
    // returned non-zero). The tunnel may still be EXPOSED, so surface a
    // structured failure instead of fabricating a "stopped" success — the
    // model/user must not believe a live public tunnel is closed.
    const detail = error instanceof Error ? error.message : String(error);
    elizaLogger.error(`[stop-tunnel] failed to stop tunnel: ${detail}`);
    if (callback) {
      await callback({
        text: `Failed to stop the tunnel. It may still be exposed on port ${previousPort} (${previousUrl}). ${detail}`,
      });
    }
    return {
      success: false,
      error: `tunnel stop failed: ${detail}`,
      data: {
        action: 'tunnel_stop_failed',
        previousUrl: previousUrl ?? '',
        previousPort: previousPort ?? 0,
      },
    };
  }

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
