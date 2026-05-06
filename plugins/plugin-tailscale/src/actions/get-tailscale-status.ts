import {
  elizaLogger,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
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

function readVerbose(options: unknown): boolean {
  const direct = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const params =
    direct.parameters && typeof direct.parameters === 'object'
      ? (direct.parameters as Record<string, unknown>)
      : {};
  const raw = params.verbose ?? direct.verbose;
  return raw === true || raw === 'true';
}

export const getTailscaleStatusAction: Action = {
  name: 'GET_TAILSCALE_STATUS',
  similes: ['TAILSCALE_STATUS', 'CHECK_TUNNEL', 'TUNNEL_INFO'],
  description: 'Get the current status of the Tailscale tunnel',
  descriptionCompressed: 'get current status Tailscale tunnel',
  parameters: [
    {
      name: 'verbose',
      description: 'When true, include backend provider details in the status text.',
      required: false,
      schema: { type: 'boolean', default: false },
    },
  ],
  validate: async (runtime: IAgentRuntime) => Boolean(getTunnelService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) {
      if (callback) {
        await callback({ text: 'Tunnel service is not available.' });
      }
      return { success: false, error: 'tunnel service unavailable' };
    }

    elizaLogger.info('[get-tailscale-status] reading status');
    const status = tunnelService.getStatus();
    const uptime = status.startedAt ? formatUptime(status.startedAt) : 'N/A';

    const providerLine = readVerbose(options) ? `\nProvider: ${status.provider}` : '';
    const responseText = status.active
      ? `✅ tailscale tunnel is active.\n\nURL: ${status.url}\nLocal port: ${status.port}\nUptime: ${uptime}`
      : '❌ No active tailscale tunnel. To start a tunnel, say "start tailscale tunnel on port [PORT]".';
    const responseTextWithDetails = `${responseText}${providerLine}`;

    if (callback) {
      await callback({ text: responseTextWithDetails });
    }
    return {
      success: true,
      text: responseTextWithDetails,
      data: {
        action: 'tunnel_status',
        active: status.active,
        url: status.url ?? '',
        port: status.port ?? 0,
        provider: status.provider,
        uptime,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'What is the tailscale tunnel status?' },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ tailscale tunnel is active.\n\nURL: https://device.tail-scale.ts.net\nLocal port: 3000\nUptime: 15 minutes',
          actions: ['GET_TAILSCALE_STATUS'],
        },
      },
    ],
  ],
};

export default getTailscaleStatusAction;
