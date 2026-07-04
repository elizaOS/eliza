/**
 * Unit tests for BgTaskSchedulerService and both scheduler implementations,
 * using a fake BackgroundRunner and in-memory runtime (bun:test) — no native
 * Capacitor bridge or real OS scheduler.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IBgTaskScheduler, ScheduleOptions } from '../../src';
import {
  BACKGROUND_RUNNER_SERVICE_TYPE,
  BgTaskSchedulerService,
  CapacitorBgScheduler,
  IntervalBgScheduler,
} from '../../src';
import type { BackgroundRunnerLike, CapacitorEnvironment } from '../../src/capacitor/bridge';

type DispatchEventOptions = Parameters<BackgroundRunnerLike['dispatchEvent']>[0];

function makeRunner(): BackgroundRunnerLike & { calls: DispatchEventOptions[] } {
  const calls: DispatchEventOptions[] = [];
  return {
    calls,
    dispatchEvent: async (opts) => {
      calls.push(opts);
      return undefined;
    },
  };
}

describe('plugin-background-runner: service type', () => {
  test('registers under serviceType="background_runner"', () => {
    expect(BgTaskSchedulerService.serviceType).toBe(BACKGROUND_RUNNER_SERVICE_TYPE);
    expect(BgTaskSchedulerService.serviceType).toBe('background_runner');
  });
});

describe('plugin-background-runner: pickScheduler', () => {
  test('returns CapacitorBgScheduler when Capacitor + runner are present', () => {
    const env: CapacitorEnvironment = { isCapacitor: true, runner: makeRunner() };
    const scheduler = BgTaskSchedulerService.pickScheduler(env);
    expect(scheduler).toBeInstanceOf(CapacitorBgScheduler);
    expect(scheduler.kind).toBe('capacitor');
  });

  test('falls back to IntervalBgScheduler when Capacitor is missing', () => {
    const env: CapacitorEnvironment = { isCapacitor: false, runner: null };
    const scheduler = BgTaskSchedulerService.pickScheduler(env);
    expect(scheduler).toBeInstanceOf(IntervalBgScheduler);
    expect(scheduler.kind).toBe('interval');
  });

  test('throws when on Capacitor native but runner peer dep is missing', () => {
    const env: CapacitorEnvironment = { isCapacitor: true, runner: null };
    expect(() => BgTaskSchedulerService.pickScheduler(env)).toThrow(
      /@capacitor\/background-runner.*not installed/
    );
    expect(() => BgTaskSchedulerService.pickScheduler(env)).toThrow(/INSTALL\.md/);
  });
});

describe('plugin-background-runner: CapacitorBgScheduler', () => {
  test('schedule dispatches a register event and tracks state', async () => {
    const runner = makeRunner();
    const scheduler = new CapacitorBgScheduler(runner, { isCapacitor: true });
    expect(scheduler.isScheduled()).toBe(false);

    let invoked = 0;
    await scheduler.schedule({
      label: 'eliza-tasks',
      minimumIntervalMinutes: 15,
      onWake: async () => {
        invoked += 1;
      },
    });

    expect(scheduler.isScheduled()).toBe(true);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]).toEqual({
      label: 'eliza-tasks',
      event: 'register',
      details: { minimumIntervalMinutes: 15 },
    });
    expect(invoked).toBe(0);
  });

  test('cancel dispatches a cancel event and clears state', async () => {
    const runner = makeRunner();
    const scheduler = new CapacitorBgScheduler(runner, { isCapacitor: true });
    await scheduler.schedule({
      label: 'eliza-tasks',
      minimumIntervalMinutes: 15,
      onWake: async () => {},
    });
    await scheduler.cancel();
    expect(scheduler.isScheduled()).toBe(false);
    expect(runner.calls.at(-1)).toEqual({
      label: 'eliza-tasks',
      event: 'cancel',
      details: {},
    });
  });

  test('cancel does not dispatch when nothing is scheduled', async () => {
    const runner = makeRunner();
    const scheduler = new CapacitorBgScheduler(runner, { isCapacitor: true });
    await scheduler.cancel();
    expect(runner.calls.length).toBe(0);
  });

  test('schedule outside Capacitor throws', async () => {
    const runner = makeRunner();
    const scheduler = new CapacitorBgScheduler(runner, { isCapacitor: false });
    await expect(
      scheduler.schedule({
        label: 'eliza-tasks',
        minimumIntervalMinutes: 15,
        onWake: async () => {},
      })
    ).rejects.toThrow(/outside Capacitor/);
  });
});

describe('plugin-background-runner: onWake failure surfaces to the agent', () => {
  // Captures the onWake callback wired at start() so a wake can be driven directly.
  class CapturingScheduler implements IBgTaskScheduler {
    readonly kind = 'interval' as const;
    onWake: (() => Promise<void>) | null = null;
    async schedule(options: ScheduleOptions): Promise<void> {
      this.onWake = options.onWake;
    }
    async cancel(): Promise<void> {}
    isScheduled(): boolean {
      return this.onWake !== null;
    }
  }

  class TestService extends BgTaskSchedulerService {
    readonly capturing = new CapturingScheduler();
    protected override async buildScheduler(): Promise<IBgTaskScheduler> {
      return this.capturing;
    }
  }

  test('a runDueTasks rejection is reported via runtime.reportError and re-thrown', async () => {
    const reported: Array<{ scope: string; error: unknown }> = [];
    const boom = new Error('task dispatch exploded');
    const runtime = {
      serverless: false,
      reportError: (scope: string, error: unknown) => {
        reported.push({ scope, error });
      },
      getService: () => ({
        runDueTasks: async () => {
          throw boom;
        },
      }),
    } as unknown as ConstructorParameters<typeof TestService>[0];

    const service = new TestService(runtime);
    await service.start();
    const onWake = service.capturing.onWake;
    expect(onWake).not.toBeNull();

    // The wake must reject (host stays aware) AND the failure must be reported.
    await expect((onWake as () => Promise<void>)()).rejects.toBe(boom);
    expect(reported.length).toBe(1);
    expect(reported[0]?.scope).toBe('BgTaskSchedulerService.onWake');
    expect(reported[0]?.error).toBe(boom);
  });
});

describe('plugin-background-runner: IntervalBgScheduler', () => {
  beforeEach(() => {
    mock.module('@elizaos/core', () => ({
      elizaLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));
  });
  afterEach(() => {
    mock.restore();
  });

  test('isScheduled flips true after schedule and false after cancel', async () => {
    const scheduler = new IntervalBgScheduler();
    expect(scheduler.isScheduled()).toBe(false);
    await scheduler.schedule({
      label: 'eliza-tasks',
      minimumIntervalMinutes: 1,
      onWake: async () => {},
    });
    expect(scheduler.isScheduled()).toBe(true);
    await scheduler.cancel();
    expect(scheduler.isScheduled()).toBe(false);
  });

  test('cancel leaves state unchanged when no interval is scheduled', async () => {
    const scheduler = new IntervalBgScheduler();
    await scheduler.cancel();
    expect(scheduler.isScheduled()).toBe(false);
  });

  test('reschedule replaces the prior interval', async () => {
    const scheduler = new IntervalBgScheduler();
    await scheduler.schedule({
      label: 'a',
      minimumIntervalMinutes: 1,
      onWake: async () => {},
    });
    await scheduler.schedule({
      label: 'b',
      minimumIntervalMinutes: 1,
      onWake: async () => {},
    });
    expect(scheduler.isScheduled()).toBe(true);
    await scheduler.cancel();
  });
});
