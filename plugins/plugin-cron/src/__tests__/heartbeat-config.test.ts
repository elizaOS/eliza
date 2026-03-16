import { describe, it, expect } from 'vitest';
import { resolveHeartbeatConfig, isWithinActiveHours } from '../heartbeat/config.js';
import type { IAgentRuntime } from '@elizaos/core';

function makeRuntime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: { settings },
  } as unknown as IAgentRuntime;
}

describe('heartbeat/config', () => {
  describe('resolveHeartbeatConfig', () => {
    it('returns defaults when no heartbeat config exists', () => {
      const config = resolveHeartbeatConfig(makeRuntime({}));
      expect(config.everyMs).toBe(30 * 60 * 1000);
      expect(config.activeHours).toBeNull();
      expect(config.target).toBe('last');
      expect(config.promptFile).toBe('HEARTBEAT.md');
      expect(config.enabled).toBe(true);
    });

    it('parses duration strings', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { every: '5m' } })
      );
      expect(config.everyMs).toBe(5 * 60 * 1000);
    });

    it('parses hour duration', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { every: '2h' } })
      );
      expect(config.everyMs).toBe(2 * 60 * 60 * 1000);
    });

    it('parses second duration', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { every: '30s' } })
      );
      expect(config.everyMs).toBe(30 * 1000);
    });

    it('parses active hours', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({
          heartbeat: {
            activeHours: { start: '08:00', end: '22:00' },
          },
        })
      );
      expect(config.activeHours).toEqual({ start: '08:00', end: '22:00' });
    });

    it('returns null active hours when incomplete', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({
          heartbeat: {
            activeHours: { start: '08:00' },
          },
        })
      );
      expect(config.activeHours).toBeNull();
    });

    it('respects enabled: false', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { enabled: false } })
      );
      expect(config.enabled).toBe(false);
    });

    it('uses custom prompt file', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { prompt: 'MY_HEARTBEAT.md' } })
      );
      expect(config.promptFile).toBe('MY_HEARTBEAT.md');
    });

    it('uses custom target', () => {
      const config = resolveHeartbeatConfig(
        makeRuntime({ heartbeat: { target: 'discord' } })
      );
      expect(config.target).toBe('discord');
    });
  });

  describe('isWithinActiveHours', () => {
    it('returns true when no active hours configured', () => {
      expect(isWithinActiveHours(null)).toBe(true);
    });

    // We can't easily test time-dependent behavior without mocking Date,
    // but we can test the boundary logic with known values.
    it('handles normal range (start < end)', () => {
      // Create a range that's always active (00:00 - 23:59)
      expect(isWithinActiveHours({ start: '00:00', end: '23:59' })).toBe(true);
    });

    it('handles empty range', () => {
      // A range of 00:00 - 00:00 should never be active
      expect(isWithinActiveHours({ start: '00:00', end: '00:00' })).toBe(false);
    });
  });
});
