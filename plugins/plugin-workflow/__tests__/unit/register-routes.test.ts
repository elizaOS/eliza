/** Unit test that importing `register-routes` registers the plugin's app route loader (mocked core registry). */
import { describe, expect, it, mock } from 'bun:test';

const registerAppRoutePluginLoader = mock(() => {});

mock.module('@elizaos/core', () => ({
  registerAppRoutePluginLoader,
}));

await import('../../src/register-routes.ts');

describe('workflow route registration', () => {
  it('registers its app route plugin loader from the owning plugin', () => {
    expect(registerAppRoutePluginLoader).toHaveBeenCalledWith(
      '@elizaos/plugin-workflow:routes',
      expect.any(Function)
    );
  });
});
