import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installPluginFromRegistryAction } from '../../actions/installPluginFromRegistry';
import { PluginManagerService } from '../../services/pluginManagerService';

describe('INSTALL_PLUGIN_FROM_REGISTRY action', () => {
  let mockRuntime: IAgentRuntime;
  let mockPluginManager: Partial<PluginManagerService>;

  beforeEach(() => {
    mockPluginManager = {
      installPluginFromRegistry: vi.fn(),
    };

    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      getService: vi.fn().mockReturnValue(mockPluginManager),
    } as unknown as IAgentRuntime;
  });

  describe('metadata', () => {
    it('should have correct action name in SCREAMING_CASE', () => {
      expect(installPluginFromRegistryAction.name).toBe('INSTALL_PLUGIN_FROM_REGISTRY');
    });

    it('should have validate and handler defined', () => {
      expect(installPluginFromRegistryAction.validate).toBeDefined();
      expect(installPluginFromRegistryAction.handler).toBeDefined();
    });

    it('should have examples', () => {
      expect(installPluginFromRegistryAction.examples).toBeDefined();
      expect(installPluginFromRegistryAction.examples!.length).toBeGreaterThan(0);
    });
  });

  describe('validate', () => {
    it('should return true when plugin manager is available', async () => {
      const message: Memory = {
        id: '12345678-1234-1234-1234-123456789012' as UUID,
        entityId: '12345678-1234-1234-1234-123456789015' as UUID,
        agentId: '12345678-1234-1234-1234-123456789013' as UUID,
        roomId: '12345678-1234-1234-1234-123456789014' as UUID,
        content: { text: 'install a plugin' },
      };
      const result = await installPluginFromRegistryAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it('should return false when plugin manager is not available', async () => {
      (mockRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const message: Memory = {
        id: '12345678-1234-1234-1234-123456789012' as UUID,
        entityId: '12345678-1234-1234-1234-123456789015' as UUID,
        agentId: '12345678-1234-1234-1234-123456789013' as UUID,
        roomId: '12345678-1234-1234-1234-123456789014' as UUID,
        content: { text: 'install plugin' },
      };
      const result = await installPluginFromRegistryAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    const message: Memory = {
      id: '12345678-1234-1234-1234-123456789012' as UUID,
      entityId: '12345678-1234-1234-1234-123456789015' as UUID,
      agentId: '12345678-1234-1234-1234-123456789013' as UUID,
      roomId: '12345678-1234-1234-1234-123456789014' as UUID,
      content: { text: 'install plugin from registry @elizaos/plugin-example' },
    };

    it('should extract plugin name and install', async () => {
      const installFn = mockPluginManager.installPluginFromRegistry as ReturnType<typeof vi.fn>;
      installFn.mockResolvedValue({
        name: '@elizaos/plugin-example',
        version: '1.0.0',
        status: 'installed',
      });

      const callback = vi.fn();
      await installPluginFromRegistryAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(installFn).toHaveBeenCalledWith('@elizaos/plugin-example');
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Successfully installed plugin @elizaos/plugin-example v1.0.0'),
      });
    });

    it('should handle plugins that need configuration', async () => {
      const installFn = mockPluginManager.installPluginFromRegistry as ReturnType<typeof vi.fn>;
      installFn.mockResolvedValue({
        name: '@elizaos/plugin-example',
        version: '1.0.0',
        status: 'needs_configuration',
        requiredEnvVars: [
          { name: 'API_KEY', description: 'API key', sensitive: true },
        ],
      });

      const callback = vi.fn();
      await installPluginFromRegistryAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      const callText = callback.mock.calls[0][0].text as string;
      expect(callText).toContain('requires configuration');
      expect(callText).toContain('API_KEY');
    });

    it('should handle installation errors gracefully via callback', async () => {
      const installFn = mockPluginManager.installPluginFromRegistry as ReturnType<typeof vi.fn>;
      installFn.mockRejectedValue(new Error('Network timeout'));

      const callback = vi.fn();
      await installPluginFromRegistryAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Failed to install plugin'),
      });
      expect(callback.mock.calls[0][0].text).toContain('Network timeout');
    });

    it('should handle missing plugin manager service', async () => {
      (mockRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const callback = vi.fn();
      await installPluginFromRegistryAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: 'Plugin manager service not available',
      });
    });

    it('should handle missing plugin name in message', async () => {
      const noNameMessage = {
        ...message,
        content: { text: 'install from registry' },
      };

      const callback = vi.fn();
      await installPluginFromRegistryAction.handler(
        mockRuntime,
        noNameMessage,
        undefined,
        undefined,
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Please specify a plugin name'),
      });
    });
  });
});
