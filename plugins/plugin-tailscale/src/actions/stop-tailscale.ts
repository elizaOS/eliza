import {
  elizaLogger,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';
import { getTunnelService } from '../types';

const STOP_TAILSCALE_CONTEXTS = ['connectors', 'settings', 'admin'] as const;
const STOP_TAILSCALE_KEYWORDS = [
  'tailscale',
  'tunnel',
  'stop',
  'close',
  'disconnect',
  'detener',
  'cerrar',
  'desconectar',
  'arrêter',
  'fermer',
  'déconnecter',
  'stoppen',
  'schließen',
  'trennen',
  'parar',
  'fechar',
  'interrompere',
  'chiudere',
  '停止',
  '切断',
  '关闭',
  '断开',
  '중지',
  '연결 해제',
] as const;

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'string') selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return STOP_TAILSCALE_CONTEXTS.some((context) => selected.has(context));
}

function hasStopTailscaleIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === 'string' ? message.content.text : '',
    typeof state?.values?.recentMessages === 'string' ? state.values.recentMessages : '',
  ]
    .join('\n')
    .toLowerCase();
  return STOP_TAILSCALE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export const stopTailscaleAction: Action = {
  name: 'STOP_TAILSCALE',
  contexts: [...STOP_TAILSCALE_CONTEXTS],
  contextGate: { anyOf: [...STOP_TAILSCALE_CONTEXTS] },
  roleGate: { minRole: 'USER' },
  similes: ['STOP_TUNNEL', 'CLOSE_TUNNEL', 'TAILSCALE_DOWN'],
  description: 'Stop the running Tailscale tunnel',
  descriptionCompressed: 'stop run Tailscale tunnel',
  parameters: [],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) =>
    Boolean(getTunnelService(runtime)) &&
    (hasSelectedContext(state) || hasStopTailscaleIntent(message, state)),
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    _options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) {
      if (callback) {
        await callback({ text: 'Tunnel service is not available.' });
      }
      return { success: false, error: 'tunnel service unavailable' };
    }

    if (!tunnelService.isActive()) {
      elizaLogger.warn('[stop-tailscale] no active tunnel to stop');
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
        text: `Tailscale tunnel stopped.\n\nWas running on port: ${previousPort}\nPrevious URL: ${previousUrl}`,
      });
    }
    return {
      success: true,
      text: `Tailscale tunnel stopped (was on port ${previousPort})`,
      data: {
        action: 'tunnel_stopped',
        previousUrl: previousUrl ?? '',
        previousPort: previousPort ?? 0,
      },
    };
  },
  examples: [
    [
      { name: 'user', content: { text: 'Stop the tailscale tunnel' } },
      {
        name: 'assistant',
        content: {
          text: 'Tailscale tunnel stopped.\n\nWas running on port: 3000\nPrevious URL: https://device.tail-scale.ts.net',
          actions: ['STOP_TAILSCALE'],
        },
      },
    ],
  ],
};

export default stopTailscaleAction;
