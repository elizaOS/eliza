import type { Provider } from '@elizaos/core';
import { getTunnelService } from '../types';

/**
 * Surfaces the active tunnel's status into the model's state. Renders a
 * one-line text summary and exposes the raw status object via `data`.
 *
 * Backend-agnostic — works with whichever tunnel implementation
 * (`LocalTunnelService` here, `CloudTunnelService` in plugin-elizacloud,
 * the ngrok service, etc.) won the `serviceType="tunnel"` slot.
 */
export const tunnelStateProvider: Provider = {
  name: 'TUNNEL_STATE',
  description: 'Current tunnel status: active flag, public URL, local port, provider, backend.',
  descriptionCompressed: 'Tunnel: active/url/port/provider/backend',
  contexts: ['devtools', 'system'],
  relevanceKeywords: ['tunnel', 'tailscale', 'headscale', 'ngrok', 'serve', 'funnel', 'expose'],
  position: 200,

  get: async (runtime, _message) => {
    const svc = getTunnelService(runtime);
    if (!svc) {
      return {
        text: 'No tunnel service is registered.',
        data: {
          active: false,
          available: false,
        },
      };
    }
    const status = svc.getStatus();
    const text = status.active
      ? `Tunnel ACTIVE — ${status.url ?? 'unknown URL'} (port ${status.port}, ${status.provider}${status.backend ? `/${status.backend}` : ''})`
      : `Tunnel idle (${status.provider} ready).`;
    return {
      text,
      data: {
        available: true,
        ...status,
        startedAt: status.startedAt ? status.startedAt.toISOString() : null,
      },
    };
  },
};

export default tunnelStateProvider;
