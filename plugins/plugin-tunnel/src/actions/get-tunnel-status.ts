import {
  type ActionResult,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';
import { getTunnelService } from '../types';

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}, ${minutes % 60} minute${minutes % 60 === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export async function handleGetTunnelStatus(
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

  elizaLogger.info('[get-tunnel-status] reading status');
  const status = tunnelService.getStatus();
  const uptime = status.startedAt ? formatUptime(status.startedAt) : 'N/A';

  const responseText = status.active
    ? `✅ tunnel active (${status.provider}).\n\nURL: ${status.url}\nLocal port: ${status.port}\nUptime: ${uptime}`
    : '❌ No active tunnel. Say "start tunnel on port [PORT]" to start one.';

  if (callback) {
    await callback({ text: responseText });
  }
  return {
    success: true,
    text: responseText,
    data: {
      action: 'tunnel_status',
      active: status.active,
      url: status.url ?? '',
      port: status.port ?? 0,
      provider: status.provider,
      backend: status.backend ?? '',
      uptime,
    },
  };
}
