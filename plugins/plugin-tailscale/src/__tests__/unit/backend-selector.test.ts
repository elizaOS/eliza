import { describe, expect, it } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import { selectTunnelBackend, readBackendMode } from '../../services/TunnelBackendSelector';
import { LocalTailscaleService } from '../../services/LocalTailscaleService';
import { CloudTailscaleService } from '../../services/CloudTailscaleService';

interface RuntimeStub {
  [key: string]: string | boolean | undefined;
}

function makeRuntime(settings: RuntimeStub): IAgentRuntime {
  const runtime = {
    getSetting: (key: string) => settings[key],
  };
  return runtime as unknown as IAgentRuntime;
}

describe('TunnelBackendSelector (tailscale)', () => {
  describe('readBackendMode', () => {
    it('defaults to auto when unset', () => {
      expect(readBackendMode(makeRuntime({}))).toBe('auto');
    });

    it('parses local / cloud / auto', () => {
      expect(readBackendMode(makeRuntime({ TAILSCALE_BACKEND: 'local' }))).toBe('local');
      expect(readBackendMode(makeRuntime({ TAILSCALE_BACKEND: 'cloud' }))).toBe('cloud');
      expect(readBackendMode(makeRuntime({ TAILSCALE_BACKEND: 'auto' }))).toBe('auto');
    });

    it('falls back to auto for invalid values', () => {
      expect(readBackendMode(makeRuntime({ TAILSCALE_BACKEND: 'wat' }))).toBe('auto');
    });
  });

  describe('selectTunnelBackend', () => {
    it('forces LocalTailscaleService when TAILSCALE_BACKEND=local', () => {
      const decision = selectTunnelBackend(makeRuntime({ TAILSCALE_BACKEND: 'local' }));
      expect(decision.backend).toBe(LocalTailscaleService);
      expect(decision.mode).toBe('local');
    });

    it('forces CloudTailscaleService when TAILSCALE_BACKEND=cloud', () => {
      const decision = selectTunnelBackend(makeRuntime({ TAILSCALE_BACKEND: 'cloud' }));
      expect(decision.backend).toBe(CloudTailscaleService);
      expect(decision.mode).toBe('cloud');
    });

    it('auto: picks Cloud when ELIZAOS_CLOUD_API_KEY + ENABLED present', () => {
      const decision = selectTunnelBackend(
        makeRuntime({
          TAILSCALE_BACKEND: 'auto',
          ELIZAOS_CLOUD_API_KEY: 'eliza_xxx',
          ELIZAOS_CLOUD_ENABLED: 'true',
        }),
      );
      expect(decision.backend).toBe(CloudTailscaleService);
      expect(decision.reason).toContain('cloud connected');
    });

    it('auto: falls back to LocalTailscaleService when cloud creds missing', () => {
      const decision = selectTunnelBackend(makeRuntime({ TAILSCALE_BACKEND: 'auto' }));
      expect(decision.backend).toBe(LocalTailscaleService);
      expect(decision.reason).toContain('cloud not connected');
    });

    it('auto: stays LocalTailscaleService when cloud key set but ENABLED is false', () => {
      const decision = selectTunnelBackend(
        makeRuntime({
          TAILSCALE_BACKEND: 'auto',
          ELIZAOS_CLOUD_API_KEY: 'eliza_xxx',
          ELIZAOS_CLOUD_ENABLED: 'false',
        }),
      );
      expect(decision.backend).toBe(LocalTailscaleService);
    });
  });
});
