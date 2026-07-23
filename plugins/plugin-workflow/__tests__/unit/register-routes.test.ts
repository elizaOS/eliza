/** Unit test for the workflow plugin's app-route loader registration boundary. */
import { describe, expect, it, mock } from 'bun:test';
import { registerWorkflowRoutePlugin } from '../../src/register-routes';

const registerAppRoutePluginLoader = mock(() => {});

describe('workflow route registration', () => {
  it('registers its app route plugin loader from the owning plugin', () => {
    registerWorkflowRoutePlugin(registerAppRoutePluginLoader);

    expect(registerAppRoutePluginLoader).toHaveBeenCalledWith(
      '@elizaos/plugin-workflow:routes',
      expect.any(Function)
    );
  });
});
