// This test file is disabled as it was written for the old local registry service.
// The new API-based registry system is tested in src/test-registry.ts
// and through the API service tests in packages/api-service/

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { searchPluginAction, getPluginDetailsAction } from '../../actions/searchPluginAction';
import { clonePluginAction } from '../../actions/clonePluginAction';
import * as pluginRegistryService from '../../services/pluginRegistryService';

// Mock the entire pluginRegistryService
vi.mock('../../services/pluginRegistryService', () => ({
  searchPluginsByContent: vi.fn(),
  getPluginDetails: vi.fn(),
  clonePlugin: vi.fn(),
}));

describe('Registry Integration E2E Tests', () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = {
      agentId: 'test-agent' as UUID,
      actions: [],
      registerAction: (action: any) => runtime.actions.push(action),
      getService: (name: any) => null,
    } as any;

    vi.clearAllMocks();
  });

  describe('searchPluginAction', () => {
    it('should call searchPluginsByContent and format results', async () => {
      const mockResults = [
        {
          name: '@elizaos/plugin-weather',
          description: 'A weather plugin',
          score: 0.9,
          tags: ['weather'],
        },
      ];
      (pluginRegistryService.searchPluginsByContent as any).mockResolvedValue(mockResults);

      const message = { content: { text: 'search for weather plugins' } } as Memory;
      const callback = vi.fn();

      await searchPluginAction.handler(runtime, message, undefined, undefined, callback);

      expect(pluginRegistryService.searchPluginsByContent).toHaveBeenCalledWith('weather plugins');
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Found 1 plugin'),
        })
      );
    });
  });

  describe('getPluginDetailsAction', () => {
    it('should call getPluginDetails and format details', async () => {
      const mockDetails = {
        name: '@elizaos/plugin-weather',
        description: 'A weather plugin',
        version: '1.0.0',
        tags: ['weather'],
        features: ['current weather'],
      };
      (pluginRegistryService.getPluginDetails as any).mockResolvedValue(mockDetails);

      const message = { content: { text: 'get details for @elizaos/plugin-weather' } } as Memory;
      const callback = vi.fn();

      await getPluginDetailsAction.handler(runtime, message, undefined, undefined, callback);

      expect(pluginRegistryService.getPluginDetails).toHaveBeenCalledWith(
        '@elizaos/plugin-weather'
      );
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('**@elizaos/plugin-weather** Details'),
        })
      );
    });
  });

  describe('clonePluginAction', () => {
    it('should call clonePlugin and report success', async () => {
      const mockResult = {
        success: true,
        pluginName: '@elizaos/plugin-weather',
        localPath: '/cloned-plugins/plugin-weather',
      };
      (pluginRegistryService.clonePlugin as any).mockResolvedValue(mockResult);

      const message = { content: { text: 'clone plugin @elizaos/plugin-weather' } } as Memory;
      const callback = vi.fn();

      await clonePluginAction.handler(runtime, message, undefined, undefined, callback);

      expect(pluginRegistryService.clonePlugin).toHaveBeenCalledWith('@elizaos/plugin-weather');
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Successfully cloned'),
        })
      );
    });
  });
});
