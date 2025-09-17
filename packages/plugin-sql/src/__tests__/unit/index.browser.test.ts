import { describe, it, expect, mock } from 'bun:test';
import { plugin } from '../../index.browser';

describe('plugin-sql browser entrypoint', () => {
  it('skips adapter registration when runtime is ready', async () => {
    const runtime = {
      agentId: '00000000-0000-0000-0000-000000000000',
      isReady: mock(() => Promise.resolve(true)),
      registerDatabaseAdapter: mock(() => {}),
    } as any;

    await plugin.init?.({}, runtime);

    expect(runtime.isReady).toHaveBeenCalledTimes(1);
    expect(runtime.registerDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('registers PGlite adapter when readiness check fails', async () => {
    const runtime = {
      agentId: '00000000-0000-0000-0000-000000000001',
      isReady: mock(() => Promise.reject(new Error('no adapter'))),
      registerDatabaseAdapter: mock(() => {}),
    } as any;

    await plugin.init?.({}, runtime);

    expect(runtime.isReady).toHaveBeenCalledTimes(1);
    expect(runtime.registerDatabaseAdapter).toHaveBeenCalledTimes(1);
    // Ensure an object resembling an adapter is passed
    const arg = (runtime.registerDatabaseAdapter as any).mock.calls[0][0];
    expect(arg).toBeDefined();
    expect(typeof arg.init).toBe('function');
    expect(typeof arg.isReady).toBe('function');
  });
});
