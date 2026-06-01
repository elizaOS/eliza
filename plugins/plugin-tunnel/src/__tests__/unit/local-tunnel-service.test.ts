import { describe, expect, it, mock } from 'bun:test';
import type { HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { handleStartTunnel } from '../../actions/start-tunnel';
import { tunnelAction } from '../../actions/tunnel';
import type { ITunnelService } from '../../types';

function tunnelService(overrides: Partial<ITunnelService> = {}): ITunnelService {
  return {
    getStatus: mock(() => ({
      active: false,
      url: 'https://device.example.ts.net',
      port: 8080,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      provider: 'tailscale',
      backend: 'local-cli',
    })),
    getUrl: mock(() => 'https://device.example.ts.net'),
    isActive: mock(() => false),
    startTunnel: mock(async () => 'https://device.example.ts.net'),
    stopTunnel: mock(async () => {}),
    ...overrides,
  };
}

function runtime(service: ITunnelService | null, modelResponse = '{"port": 3000}'): IAgentRuntime {
  return {
    getService: mock(() => service),
    useModel: mock(async () => modelResponse),
  } as unknown as IAgentRuntime;
}

const message = { content: { text: 'start a tunnel' } } as Memory;

describe('plugin-tunnel start action', () => {
  it('starts the active tunnel service with an explicit string port and reports callback data', async () => {
    const service = tunnelService();
    const callback = mock(async () => {}) as HandlerCallback;

    const result = await handleStartTunnel(
      runtime(service),
      message,
      undefined,
      { port: '8080' },
      callback
    );

    expect(service.startTunnel).toHaveBeenCalledWith(8080);
    expect(callback).toHaveBeenCalledWith({
      text: 'Tunnel started (tailscale).\n\nURL: https://device.example.ts.net\nLocal port: 8080',
    });
    expect(result).toEqual({
      success: true,
      text: 'Tunnel started on port 8080',
      data: {
        action: 'tunnel_started',
        tunnelUrl: 'https://device.example.ts.net',
        port: 8080,
        provider: 'tailscale',
      },
    });
  });

  it('falls back to model-derived ports and defaults invalid model output to 3000', async () => {
    const validService = tunnelService();
    const validRuntime = runtime(validService, '{"port": 4321}');

    await handleStartTunnel(validRuntime, message);

    expect(validRuntime.useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, expect.any(Object));
    expect(validService.startTunnel).toHaveBeenCalledWith(4321);

    const invalidService = tunnelService();
    await handleStartTunnel(runtime(invalidService, '{"port": 999999}'), message);

    expect(invalidService.startTunnel).toHaveBeenCalledWith(3000);
  });

  it('does not start when the tunnel service is missing or already active', async () => {
    const missingCallback = mock(async () => {}) as HandlerCallback;

    await expect(
      handleStartTunnel(runtime(null), message, undefined, undefined, missingCallback)
    ).resolves.toEqual({ success: false, error: 'tunnel service unavailable' });
    expect(missingCallback).toHaveBeenCalledWith({
      text: 'Tunnel service is not available. Configure plugin-tunnel, plugin-elizacloud, or plugin-ngrok.',
    });

    const activeService = tunnelService({ isActive: mock(() => true) });
    await expect(handleStartTunnel(runtime(activeService), message)).resolves.toEqual({
      success: false,
      error: 'tunnel already active',
    });
    expect(activeService.startTunnel).not.toHaveBeenCalled();
  });

  it('dispatches nested TUNNEL action parameters to start without leaking action into sub-options', async () => {
    const service = tunnelService();

    const result = await tunnelAction.handler(
      runtime(service),
      message,
      undefined,
      { parameters: { action: 'start', parameters: { port: 9090 } } }
    );

    expect(service.startTunnel).toHaveBeenCalledWith(9090);
    expect(result.success).toBe(true);
  });
});
