import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  BACKGROUND_RUNNER_SERVICE_TYPE,
  BgTaskSchedulerService,
  CapacitorBgScheduler,
  IntervalBgScheduler,
} from '../../src';
import type { BackgroundRunnerLike, CapacitorEnvironment } from '../../src/capacitor/bridge';

function makeRunner(): BackgroundRunnerLike & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    dispatchEvent: async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
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

  test('falls back to IntervalBgScheduler when Capacitor is present but runner module is not', () => {
    const env: CapacitorEnvironment = { isCapacitor: true, runner: null };
    const scheduler = BgTaskSchedulerService.pickScheduler(env);
    expect(scheduler).toBeInstanceOf(IntervalBgScheduler);
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

  test('cancel is a no-op when nothing is scheduled', async () => {
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

  test('cancel is a no-op when no interval is scheduled', async () => {
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
