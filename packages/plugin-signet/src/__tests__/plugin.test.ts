import { describe, it, expect } from 'bun:test';
import { signetPlugin } from '../plugin.ts';

describe('plugin-signet', () => {
  it('should export a valid plugin object', () => {
    expect(signetPlugin).toBeDefined();
    expect(signetPlugin.name).toBe('plugin-signet');
    expect(signetPlugin.description).toContain('Signet');
  });

  it('should have two actions', () => {
    expect(signetPlugin.actions).toHaveLength(2);
    const names = signetPlugin.actions!.map((a) => a.name);
    expect(names).toContain('SIGNET_ESTIMATE');
    expect(names).toContain('SIGNET_POST_SPOTLIGHT');
  });

  it('should have one provider', () => {
    expect(signetPlugin.providers).toHaveLength(1);
    expect(signetPlugin.providers![0].name).toBe('SIGNET_SPOTLIGHT_STATUS');
  });

  it('should define config with defaults', () => {
    expect(signetPlugin.config).toBeDefined();
    expect(signetPlugin.config!.SIGNET_BASE_URL).toBe('https://signet.sebayaki.com');
    expect(signetPlugin.config!.SIGNET_RPC_URL).toBe('https://mainnet.base.org');
  });

  it('estimate action should always validate', async () => {
    const estimate = signetPlugin.actions!.find((a) => a.name === 'SIGNET_ESTIMATE')!;
    const result = await estimate.validate({} as any, {} as any, undefined);
    expect(result).toBe(true);
  });

  it('post action should fail validation without private key', async () => {
    const post = signetPlugin.actions!.find((a) => a.name === 'SIGNET_POST_SPOTLIGHT')!;
    const mockRuntime = {
      getSetting: () => null,
    } as any;
    const result = await post.validate(mockRuntime, {} as any, undefined);
    expect(result).toBe(false);
  });

  it('post action should pass validation with private key', async () => {
    const post = signetPlugin.actions!.find((a) => a.name === 'SIGNET_POST_SPOTLIGHT')!;
    const mockRuntime = {
      getSetting: (key: string) =>
        key === 'SIGNET_PRIVATE_KEY'
          ? '0x0000000000000000000000000000000000000000000000000000000000000001'
          : null,
    } as any;
    const result = await post.validate(mockRuntime, {} as any, undefined);
    expect(result).toBe(true);
  });

  it('actions should have examples', () => {
    for (const action of signetPlugin.actions!) {
      expect(action.examples).toBeDefined();
      expect(action.examples!.length).toBeGreaterThan(0);
    }
  });
});
