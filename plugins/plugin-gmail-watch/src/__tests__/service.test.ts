import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';

// ---------------------------------------------------------------------------
// Backoff formula (mirrors the private constants from GmailWatchService)
// ---------------------------------------------------------------------------

const INITIAL_RESTART_DELAY_MS = 10_000;
const MAX_RESTART_DELAY_MS = 300_000;
const MAX_RESTART_ATTEMPTS = 10;

function calculateBackoffDelay(attempt: number): number {
  return Math.min(
    INITIAL_RESTART_DELAY_MS * Math.pow(2, attempt - 1),
    MAX_RESTART_DELAY_MS,
  );
}

// ---------------------------------------------------------------------------
// Hoist mock references so vi.mock (also hoisted) can use them
// ---------------------------------------------------------------------------

const { mockSpawn, mockOn, mockKill } = vi.hoisted(() => {
  const mockOn = vi.fn();
  const mockKill = vi.fn();
  const mockSpawn = vi.fn(() => ({
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: mockOn,
    kill: mockKill,
  }));
  return { mockSpawn, mockOn, mockKill };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFile: (
    _cmd: string,
    _args: string[],
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    cb(null, '/usr/local/bin/gog\n');
  },
}));

// Static imports (use the mocks automatically since vi.mock is hoisted)
import { GmailWatchService } from '../service.js';
import { gmailWatchPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(settings: Record<string, object> = {}): IAgentRuntime {
  return {
    character: { settings },
    registerTaskWorker: vi.fn(),
  } as unknown as IAgentRuntime;
}

function makeFullSettings(): Record<string, object> {
  return {
    hooks: {
      enabled: true,
      token: 'shared-secret',
      presets: ['gmail'],
      gmail: {
        account: 'user@gmail.com',
        label: 'INBOX',
        topic: 'projects/my-project/topics/gog-gmail-watch',
        pushToken: 'my-push-token',
        hookUrl: 'http://127.0.0.1:18789/hooks/gmail',
        includeBody: true,
        maxBytes: 20000,
        renewEveryMinutes: 360,
        serve: {
          bind: '127.0.0.1',
          port: 8788,
          path: '/gmail-pubsub',
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSpawn.mockClear();
  mockOn.mockClear();
  mockKill.mockClear();
});

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

describe('Backoff calculation', () => {
  it('first attempt uses the initial delay', () => {
    expect(calculateBackoffDelay(1)).toBe(INITIAL_RESTART_DELAY_MS);
  });

  it('second attempt doubles the initial delay', () => {
    expect(calculateBackoffDelay(2)).toBe(INITIAL_RESTART_DELAY_MS * 2);
  });

  it('third attempt is 4x the initial delay', () => {
    expect(calculateBackoffDelay(3)).toBe(INITIAL_RESTART_DELAY_MS * 4);
  });

  it('clamps to the maximum delay at high attempts', () => {
    expect(calculateBackoffDelay(50)).toBe(MAX_RESTART_DELAY_MS);
  });

  it('all attempts are within bounds', () => {
    for (let i = 1; i <= MAX_RESTART_ATTEMPTS; i++) {
      const delay = calculateBackoffDelay(i);
      expect(delay).toBeGreaterThanOrEqual(INITIAL_RESTART_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(MAX_RESTART_DELAY_MS);
    }
  });

  it('delays are monotonically non-decreasing', () => {
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const delay = calculateBackoffDelay(i);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  it('specific known values match', () => {
    expect(calculateBackoffDelay(1)).toBe(10_000);
    expect(calculateBackoffDelay(2)).toBe(20_000);
    expect(calculateBackoffDelay(3)).toBe(40_000);
    expect(calculateBackoffDelay(4)).toBe(80_000);
    expect(calculateBackoffDelay(5)).toBe(160_000);
    expect(calculateBackoffDelay(6)).toBe(300_000);
    expect(calculateBackoffDelay(7)).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Config resolution (via the GmailWatchService.start path)
// ---------------------------------------------------------------------------

describe('Config resolution', () => {
  it('returns a service when account is configured', async () => {
    const runtime = makeRuntime(makeFullSettings());
    const service = await GmailWatchService.start(runtime);
    expect(service).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  it('skips initialization when hooks.gmail.account is missing', async () => {
    const runtime = makeRuntime({});
    const service = await GmailWatchService.start(runtime);
    expect(service).toBeDefined();
    expect(mockSpawn).not.toHaveBeenCalled();

    await service.stop();
  });

  it('skips initialization when account is empty string', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: '' } },
    });
    const service = await GmailWatchService.start(runtime);
    expect(service).toBeDefined();
    expect(mockSpawn).not.toHaveBeenCalled();

    await service.stop();
  });

  it('skips initialization when account is only whitespace', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: '   ' } },
    });
    const service = await GmailWatchService.start(runtime);
    expect(service).toBeDefined();
    expect(mockSpawn).not.toHaveBeenCalled();

    await service.stop();
  });

  it('resolves defaults when only account is provided', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: 'me@example.com' } },
    });
    const service = await GmailWatchService.start(runtime);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--account');
    expect(args).toContain('me@example.com');
    expect(args).toContain('--bind');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('--port');
    expect(args).toContain('8788');
    expect(args).toContain('--path');
    expect(args).toContain('/gmail-pubsub');

    await service.stop();
  });

  it('passes custom serve config to spawn', async () => {
    const runtime = makeRuntime({
      hooks: {
        gmail: {
          account: 'user@gmail.com',
          serve: {
            bind: '0.0.0.0',
            port: 9999,
            path: '/custom',
          },
        },
      },
    });
    const service = await GmailWatchService.start(runtime);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('0.0.0.0');
    expect(args).toContain('9999');
    expect(args).toContain('/custom');

    await service.stop();
  });

  it('includes --hook-token when hooks.token is set', async () => {
    const runtime = makeRuntime(makeFullSettings());
    const service = await GmailWatchService.start(runtime);

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--hook-token');
    expect(args).toContain('shared-secret');

    await service.stop();
  });

  it('includes --token when pushToken is set', async () => {
    const runtime = makeRuntime(makeFullSettings());
    const service = await GmailWatchService.start(runtime);

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--token');
    expect(args).toContain('my-push-token');

    await service.stop();
  });

  it('includes --include-body when includeBody is true', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: 'a@b.com', includeBody: true } },
    });
    const service = await GmailWatchService.start(runtime);

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--include-body');

    await service.stop();
  });

  it('omits --include-body when includeBody is false', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: 'a@b.com', includeBody: false } },
    });
    const service = await GmailWatchService.start(runtime);

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--include-body');

    await service.stop();
  });

  it('does not include --hook-token when hooks.token is empty', async () => {
    const runtime = makeRuntime({
      hooks: { gmail: { account: 'a@b.com' } },
    });
    const service = await GmailWatchService.start(runtime);

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--hook-token');

    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

describe('Service lifecycle', () => {
  it('stop clears timer and kills child', async () => {
    const runtime = makeRuntime(makeFullSettings());
    const service = await GmailWatchService.start(runtime);

    await service.stop();

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop is safe to call multiple times', async () => {
    const runtime = makeRuntime(makeFullSettings());
    const service = await GmailWatchService.start(runtime);

    await service.stop();
    await service.stop();
  });

  it('stop is safe to call when never initialized', async () => {
    const runtime = makeRuntime({});
    const service = await GmailWatchService.start(runtime);
    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

describe('Plugin exports', () => {
  it('exports gmailWatchPlugin with correct name', () => {
    expect(gmailWatchPlugin.name).toBe('gmail-watch');
    expect(gmailWatchPlugin.description).toBeDefined();
    expect(gmailWatchPlugin.services).toBeDefined();
    expect(gmailWatchPlugin.services!.length).toBe(1);
  });

  it('exports default plugin', async () => {
    const mod = await import('../index.js');
    expect(mod.default).toBeDefined();
    expect(mod.default.name).toBe('gmail-watch');
  });

  it('exports GmailWatchService class', () => {
    expect(GmailWatchService).toBeDefined();
    expect(typeof GmailWatchService.start).toBe('function');
  });

  it('service has correct serviceType', () => {
    expect(GmailWatchService.serviceType).toBe('GMAIL_WATCH');
  });
});

// ---------------------------------------------------------------------------
// Renewal timing
// ---------------------------------------------------------------------------

describe('Renewal timing', () => {
  it('default renewal interval is 6 hours in milliseconds', () => {
    const DEFAULT_RENEW_MINUTES = 360;
    const intervalMs = DEFAULT_RENEW_MINUTES * 60 * 1000;
    expect(intervalMs).toBe(21_600_000);
  });

  it('custom renewal interval calculates correctly', () => {
    const renewMinutes = 30;
    const intervalMs = renewMinutes * 60 * 1000;
    expect(intervalMs).toBe(1_800_000);
  });

  it('createTask is called with correct interval for renewal', async () => {
    const createTaskMock = vi.fn().mockResolvedValue('task-id-1');
    const getTasksByNameMock = vi.fn().mockResolvedValue([]);
    const runtime = makeRuntime({
      hooks: {
        gmail: {
          account: 'a@b.com',
          renewEveryMinutes: 60,
        },
      },
    }) as IAgentRuntime & { createTask: ReturnType<typeof vi.fn>; getTasksByName: ReturnType<typeof vi.fn> };
    runtime.createTask = createTaskMock;
    runtime.getTasksByName = getTasksByNameMock;

    const service = await GmailWatchService.start(runtime);

    // Renewal task should be created with 60 * 60 * 1000 = 3_600_000ms in metadata
    expect(createTaskMock).toHaveBeenCalled();
    const call = createTaskMock.mock.calls[0]?.[0];
    expect(call?.metadata?.updateInterval).toBe(3_600_000);
    expect(call?.metadata?.baseInterval).toBe(3_600_000);

    await service.stop();
  });
});
