import { describe, expect, it } from 'vitest';
import { tunnelAction } from '../../actions/tunnel';
import { tunnelStateProvider } from '../../providers/tunnel-state';
import { LocalTunnelService } from '../../services/LocalTunnelService';

describe('plugin-tunnel exports', () => {
  it('LocalTunnelService registers under serviceType="tunnel"', () => {
    expect(LocalTunnelService.serviceType).toBe('tunnel');
  });

  it('TUNNEL action exposes start/stop/status enum and provider-neutral similes', () => {
    expect(tunnelAction.name).toBe('TUNNEL');
    const opParam = tunnelAction.parameters?.find((p) => p.name === 'action');
    expect(opParam).toBeDefined();
    expect((opParam?.schema as { enum?: string[] }).enum).toEqual(['start', 'stop', 'status']);
    expect(tunnelAction.similes).toEqual(
      expect.arrayContaining(['OPEN_TUNNEL', 'CHECK_TUNNEL'])
    );
    expect(tunnelAction.similes).not.toContain('TAILSCALE');
    expect(tunnelAction.similes).not.toContain('START_TUNNEL');
  });

  it('TUNNEL_STATE provider has get() and is named correctly', () => {
    expect(tunnelStateProvider.name).toBe('TUNNEL_STATE');
    expect(typeof tunnelStateProvider.get).toBe('function');
  });
});
