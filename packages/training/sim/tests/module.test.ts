import { describe, expect, it } from 'bun:test';
import { AbstractBabylonSystem, defineSystem } from '../core/system';
import type {
  EngineContext,
  SystemTickResult,
  TickContext,
} from '../core/types';
import { TickPhase } from '../core/types';

describe('defineSystem', () => {
  it('returns a valid BabylonSystem from a definition', () => {
    const mod = defineSystem({
      id: 'test',
      name: 'Test Module',
      phase: TickPhase.Bootstrap,
      onTick: async () => ({ metrics: { ran: true } }),
    });

    expect(mod.id).toBe('test');
    expect(mod.name).toBe('Test Module');
    expect(mod.phase).toBe(TickPhase.Bootstrap);
    expect(typeof mod.onTick).toBe('function');
  });

  it('preserves optional fields', () => {
    const mod = defineSystem({
      id: 'with-opts',
      name: 'With Options',
      phase: TickPhase.Markets,
      dependencies: ['dep-a', 'dep-b'],
      skipDeadlineCheck: true,
      intervals: {
        cleanup: {
          every: 5,
          handler: async () => ({}),
        },
      },
      register: async () => {},
      destroy: async () => {},
      onTick: async () => ({}),
    });

    expect(mod.dependencies).toEqual(['dep-a', 'dep-b']);
    expect(mod.skipDeadlineCheck).toBe(true);
    expect(mod.intervals?.cleanup?.every).toBe(5);
    expect(typeof mod.register).toBe('function');
    expect(typeof mod.destroy).toBe('function');
  });

  it('omitted optional fields are undefined', () => {
    const mod = defineSystem({
      id: 'minimal',
      name: 'Minimal',
      phase: TickPhase.Events,
      onTick: async () => ({}),
    });

    expect(mod.dependencies).toBeUndefined();
    expect(mod.skipDeadlineCheck).toBeUndefined();
    expect(mod.intervals).toBeUndefined();
    expect(mod.register).toBeUndefined();
    expect(mod.destroy).toBeUndefined();
  });

  it('onTick can return metrics, sharedData, and warnings', async () => {
    const mod = defineSystem({
      id: 'full-result',
      name: 'Full Result',
      phase: TickPhase.Bootstrap,
      onTick: async () => ({
        metrics: { count: 42, active: true },
        sharedData: { key: 'value' },
        warnings: ['heads up'],
      }),
    });

    const result = await mod.onTick({} as TickContext);
    expect(result.metrics).toEqual({ count: 42, active: true });
    expect(result.sharedData).toEqual({ key: 'value' });
    expect(result.warnings).toEqual(['heads up']);
  });
});

describe('AbstractBabylonSystem (deprecated)', () => {
  it('can be extended to create a module', async () => {
    class TestModule extends AbstractBabylonSystem {
      readonly id = 'test-class';
      readonly name = 'Test Class Module';
      readonly phase = TickPhase.Bootstrap;

      async onTick(_ctx: TickContext): Promise<SystemTickResult> {
        return { metrics: { classWorks: true } };
      }
    }

    const mod = new TestModule();
    expect(mod.id).toBe('test-class');
    expect(typeof mod.onTick).toBe('function');

    const result = await mod.onTick({} as TickContext);
    expect(result.metrics?.classWorks).toBe(true);
  });

  it('has no-op defaults for register and destroy', async () => {
    class Minimal extends AbstractBabylonSystem {
      readonly id = 'min';
      readonly name = 'Min';
      readonly phase = TickPhase.Events;
      async onTick(_ctx: TickContext): Promise<SystemTickResult> {
        return {};
      }
    }

    const mod = new Minimal();
    // Should not throw
    await mod.register({} as unknown as EngineContext);
    await mod.destroy();
  });
});
