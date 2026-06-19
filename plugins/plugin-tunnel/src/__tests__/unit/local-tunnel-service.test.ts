import { describe, expect, it, mock } from 'bun:test';
import type { HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { handleGetTunnelStatus } from '../../actions/get-tunnel-status';
import { handleStartTunnel } from '../../actions/start-tunnel';
import { handleStopTunnel } from '../../actions/stop-tunnel';
import { tunnelAction } from '../../actions/tunnel';
import { validateTunnelConfig } from '../../environment';
import { tunnelStateProvider } from '../../providers/tunnel-state';
import { LocalTunnelService } from '../../services/LocalTunnelService';
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

  it.each([
    0,
    65_536,
    1.5,
    Number.NaN,
    'abc',
    '../../3000',
  ])('rejects explicit hostile port %s before model fallback or service start', async (port) => {
    const service = tunnelService();
    const rt = runtime(service);
    const callback = mock(async () => {}) as HandlerCallback;

    await expect(handleStartTunnel(rt, message, undefined, { port }, callback)).resolves.toEqual({
      success: false,
      error: 'invalid tunnel port',
    });

    expect(rt.useModel).not.toHaveBeenCalled();
    expect(service.startTunnel).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      text: 'Invalid tunnel port. Port must be an integer between 1 and 65535.',
    });
  });

  it('dispatches nested TUNNEL action parameters to start without leaking action into sub-options', async () => {
    const service = tunnelService();

    const result = await tunnelAction.handler(runtime(service), message, undefined, {
      parameters: { action: 'start', parameters: { port: 9090 } },
    });

    expect(service.startTunnel).toHaveBeenCalledWith(9090);
    expect(result.success).toBe(true);
  });

  it('returns structured errors for missing and unknown TUNNEL actions', async () => {
    const callback = mock(async () => {}) as HandlerCallback;
    const rt = runtime(tunnelService());

    await expect(tunnelAction.handler(rt, message, undefined, {}, callback)).resolves.toEqual({
      success: false,
      error: 'TUNNEL requires action=start|stop|status',
    });
    await expect(
      tunnelAction.handler(rt, message, undefined, { action: 'restart<script>' }, callback)
    ).resolves.toEqual({
      success: false,
      error: 'Unknown TUNNEL action "restart<script>". Supported: start, stop, status',
    });
  });
});

describe('plugin-tunnel stop/status/provider/config behavior', () => {
  it('stops an active tunnel and reports the previous endpoint', async () => {
    const service = tunnelService({
      isActive: mock(() => true),
      getStatus: mock(() => ({
        active: true,
        url: 'https://device.example.ts.net',
        port: 8080,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        provider: 'tailscale',
        backend: 'local-cli',
      })),
    });
    const callback = mock(async () => {}) as HandlerCallback;

    await expect(
      handleStopTunnel(runtime(service), message, undefined, undefined, callback)
    ).resolves.toMatchObject({
      success: true,
      data: {
        action: 'tunnel_stopped',
        previousUrl: 'https://device.example.ts.net',
        previousPort: 8080,
      },
    });
    expect(service.stopTunnel).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      text: 'Tunnel stopped.\n\nWas running on port: 8080\nPrevious URL: https://device.example.ts.net',
    });
  });

  it('reports status and provider state without mutating inactive services', async () => {
    const service = tunnelService({
      isActive: mock(() => false),
      getStatus: mock(() => ({
        active: false,
        url: null,
        port: null,
        startedAt: null,
        provider: 'tailscale',
        backend: 'local-cli',
      })),
    });

    await expect(handleGetTunnelStatus(runtime(service), message)).resolves.toMatchObject({
      success: true,
      data: {
        action: 'tunnel_status',
        active: false,
        provider: 'tailscale',
        backend: 'local-cli',
      },
    });
    await expect(tunnelStateProvider.get(runtime(service), message)).resolves.toEqual({
      text: 'Tunnel idle (tailscale ready).',
      data: {
        available: true,
        active: false,
        url: null,
        port: null,
        startedAt: null,
        provider: 'tailscale',
        backend: 'local-cli',
      },
    });
    expect(service.startTunnel).not.toHaveBeenCalled();
    expect(service.stopTunnel).not.toHaveBeenCalled();
  });

  it('sanitizes tunnel config and falls back on hostile default ports', async () => {
    const getSetting = mock((key: string) => {
      const values: Record<string, unknown> = {
        TUNNEL_TAGS: ' tag:one, ,tag:two ',
        TUNNEL_FUNNEL: '1',
        TUNNEL_DEFAULT_PORT: '../../99999',
      };
      return values[key] ?? null;
    });

    await expect(validateTunnelConfig({ getSetting } as unknown as IAgentRuntime)).resolves.toEqual(
      {
        TUNNEL_TAGS: ['tag:one', 'tag:two'],
        TUNNEL_FUNNEL: true,
        TUNNEL_DEFAULT_PORT: 3000,
      }
    );
  });

  it.each([
    0,
    65_536,
    1.5,
    Number.NaN,
  ])('LocalTunnelService rejects hostile runtime port %s before config or CLI calls', async (port) => {
    const service = new LocalTunnelService({
      getSetting: mock(() => null),
    } as unknown as IAgentRuntime);

    await expect(service.startTunnel(port as number)).rejects.toThrow('Invalid port number');
  });
});
