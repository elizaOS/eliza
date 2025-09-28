import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PluginInstaller } from '../PluginInstaller';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PluginInstaller', () => {
  const originalSpawn = (Bun as any).spawn;
  const originalEnv = { ...process.env } as Record<string, string>;

  beforeEach(() => {
    // Reset environment to allow auto-install
    process.env = { ...originalEnv } as any;
    process.env.NODE_ENV = 'development';
    delete process.env.CI;
    delete process.env.ELIZA_TEST_MODE;
    delete process.env.ELIZA_NO_AUTO_INSTALL;
    delete process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
    process.env = { ...originalEnv } as any;
  });

  test('returns false when auto-install disallowed by env', async () => {
    const installer = new PluginInstaller();
    process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL = 'true';

    let called = 0;
    (Bun as any).spawn = ((cmd: any[]) => {
      called += 1;
      return { exited: Promise.resolve(0) } as any;
    }) as any;

    const result = await installer.tryInstall('@elizaos/plugin-demo');
    expect(result).toBe(false);
    expect(called).toBe(0);
  });

  test('succeeds when bun present and bun add exits 0', async () => {
    const installer = new PluginInstaller();
    const calls: any[] = [];

    (Bun as any).spawn = ((args: any[]) => {
      calls.push(args);
      // First call is bun --version, second is bun add <pkg>
      const isVersion = Array.isArray(args) && args[1] === '--version';
      const exitCode = isVersion ? 0 : 0;
      return { exited: Promise.resolve(exitCode) } as any;
    }) as any;

    const result = await installer.tryInstall('@elizaos/plugin-demo');
    expect(result).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(['bun', '--version']);
    expect(calls[1]).toEqual(['bun', 'add', '@elizaos/plugin-demo']);
  });

  test('fails when bun --version exits non-zero', async () => {
    const installer = new PluginInstaller();
    let versionCalls = 0;
    (Bun as any).spawn = ((args: any[]) => {
      if (Array.isArray(args) && args[1] === '--version') {
        versionCalls += 1;
        return { exited: Promise.resolve(1) } as any;
      }
      // would be bun add; should not be called
      return { exited: Promise.resolve(0) } as any;
    }) as any;

    const result = await installer.tryInstall('@elizaos/plugin-demo');
    expect(result).toBe(false);
    expect(versionCalls).toBe(1);
  });

  test('fails when bun add exits non-zero', async () => {
    const installer = new PluginInstaller();
    const calls: any[] = [];
    (Bun as any).spawn = ((args: any[]) => {
      calls.push(args);
      const isVersion = Array.isArray(args) && args[1] === '--version';
      return { exited: Promise.resolve(isVersion ? 0 : 1) } as any;
    }) as any;

    const result = await installer.tryInstall('@elizaos/plugin-demo');
    expect(result).toBe(false);
    expect(calls.length).toBe(2);
  });

  test('only attempts install once per plugin name', async () => {
    const installer = new PluginInstaller();
    let spawnCount = 0;
    (Bun as any).spawn = ((args: any[]) => {
      spawnCount += 1;
      const isVersion = Array.isArray(args) && args[1] === '--version';
      return { exited: Promise.resolve(isVersion ? 0 : 0) } as any;
    }) as any;

    const p = '@elizaos/plugin-demo';
    const first = await installer.tryInstall(p);
    const second = await installer.tryInstall(p);
    expect(first).toBe(true);
    expect(second).toBe(false);
    // First attempt uses 2 spawns (version + add); second attempt uses none
    expect(spawnCount).toBe(2);
  });

  test('awaits process completion before returning', async () => {
    const installer = new PluginInstaller();
    let versionResolved = false;
    let addResolved = false;
    (Bun as any).spawn = ((args: any[]) => {
      const isVersion = Array.isArray(args) && args[1] === '--version';
      return {
        exited: (async () => {
          await delay(isVersion ? 25 : 50);
          if (isVersion) versionResolved = true;
          else addResolved = true;
          return 0;
        })(),
      } as any;
    }) as any;

    const result = await installer.tryInstall('@elizaos/plugin-demo');
    expect(result).toBe(true);
    expect(versionResolved).toBe(true);
    expect(addResolved).toBe(true);
  });
});
