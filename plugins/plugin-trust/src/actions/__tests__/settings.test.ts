import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { updateSettingsAction } from '../settings';
import type { IAgentRuntime, Memory, State, UUID, WorldSettings, Setting } from '@elizaos/core';
import { ChannelType, ModelType } from '@elizaos/core';
import * as core from '@elizaos/core';
import * as settingsModule from '../settings';

// Create spies
const findWorldsForOwnerSpy = vi.spyOn(core, 'findWorldsForOwner');
const getWorldSettingsSpy = vi.spyOn(settingsModule, 'getWorldSettings');
const updateWorldSettingsSpy = vi.spyOn(settingsModule, 'updateWorldSettings');

const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as any,
    getSetting: vi.fn(),
    log: vi.fn(),
    useModel: vi.fn(),
    getWorld: vi.fn(),
    updateWorld: vi.fn(),
  } as any);

const createMockMemory = (text: string, entityId: UUID): Memory =>
  ({
    entityId,
    content: {
      text,
      channelType: ChannelType.DM,
    },
  } as Memory);

const createMockState = (text: string): State =>
  ({
    text,
    values: {},
  } as State);

const createMockSettings = (): WorldSettings => ({
  setting_a: { name: 'Setting A', description: 'First setting', usageDescription: 'The first setting', required: true, value: null },
  setting_b: {
    name: 'Setting B',
    description: 'Second setting',
    usageDescription: 'The second setting',
    required: true,
    value: null,
    dependsOn: ['setting_a'],
  },
  setting_c: { name: 'Setting C', description: 'Optional setting', usageDescription: 'An optional setting', required: false, value: null },
});

describe('updateSettingsAction', () => {
  let runtime: IAgentRuntime;
  let worldSettings: WorldSettings;
  const testEntityId = 'user-1' as UUID;
  const testServerId = 'server-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    worldSettings = createMockSettings();

    // Mock the dependencies of the action
    const mockWorld = {
      id: 'world-1' as UUID,
      serverId: testServerId,
      agentId: 'test-agent' as UUID,
      metadata: { settings: worldSettings },
    };
    
    (runtime.getWorld as Mock).mockResolvedValue(mockWorld);
    (runtime.updateWorld as Mock).mockResolvedValue(true);

    // Mock findWorldsForOwner from core
    findWorldsForOwnerSpy.mockResolvedValue([mockWorld]);

    // Set up the mocked functions
    getWorldSettingsSpy.mockResolvedValue(worldSettings);
    updateWorldSettingsSpy.mockResolvedValue(true);
  });

  describe('handler', () => {
    it('should extract and update a single setting from a user message', async () => {
      const message = createMockMemory('please set Setting A to "value1"', testEntityId);
      const state = createMockState(message.content.text!);
      const callback = vi.fn();
      
      // Mock the model to extract settings - return an object that extractValidSettings can traverse
      (runtime.useModel as Mock)
        .mockResolvedValueOnce({ setting_a: 'value1' }) // extractValidSettings looks for worldSettings keys in the result
        .mockResolvedValueOnce('{"text": "Setting A has been updated to \\"value1\\"!"}'); // generateSuccessResponse expects JSON string

      // Mock getWorldSettings to return updated settings after update
      getWorldSettingsSpy
        .mockResolvedValueOnce(worldSettings) // Initial call
        .mockResolvedValueOnce({ // After update
          ...worldSettings,
          setting_a: { ...worldSettings.setting_a, value: 'value1' }
        });
      
      // Mock updateWorldSettings to succeed
      updateWorldSettingsSpy.mockResolvedValueOnce(true);
      
      // Mock runtime.updateWorld to succeed (used by updateWorldSettings)
      (runtime.updateWorld as Mock).mockResolvedValueOnce(true);

      await updateSettingsAction.handler!(runtime, message, state, {}, callback);
      
      // Verify success response was sent
      expect(callback).toHaveBeenCalled();
      const callbackArg = callback.mock.calls[0][0];
      expect(callbackArg.text).toContain('Setting A');
      expect(callbackArg.actions).toContain('SETTING_UPDATED');
    });

    it('should handle failure when no settings can be extracted', async () => {
      const message = createMockMemory('I am not sure what to do', testEntityId);
      const state = createMockState(message.content.text!);
      const callback = vi.fn();
      
      (runtime.useModel as Mock).mockResolvedValueOnce([]); // No settings extracted
      (runtime.useModel as Mock).mockResolvedValueOnce({ text: 'I could not understand.' });

      await updateSettingsAction.handler!(runtime, message, state, {}, callback);

      expect(updateWorldSettingsSpy).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
          actions: ['SETTING_UPDATE_FAILED']
      }));
    });

    it('should complete onboarding when all required settings are configured', async () => {
        // Pre-configure setting_a with a value
        const configuredSettings = {
            ...worldSettings,
            setting_a: { ...worldSettings.setting_a, value: 'preconfigured' }
        };
        
        // Mock findWorldsForOwner to return world with pre-configured settings
        findWorldsForOwnerSpy.mockResolvedValue([{
            id: 'world-1' as UUID,
            serverId: testServerId,
            agentId: 'test-agent' as UUID,
            metadata: { settings: configuredSettings },
        }]);
        
        // Mock getWorldSettings to return pre-configured settings
        getWorldSettingsSpy.mockResolvedValue(configuredSettings);
        
        const message = createMockMemory('Set Setting B to "final_value"', testEntityId);
        const state = createMockState(message.content.text!);
        const callback = vi.fn();

        // Mock the model calls
        (runtime.useModel as Mock)
            .mockResolvedValueOnce([{ key: 'setting_b', value: 'final_value' }]) // extractSettingValues expects parsed array
            .mockResolvedValueOnce('{"text": "All settings configured! Onboarding complete!"}'); // completion response expects JSON string
        
        // Mock that after update, all required settings have values
        const completedSettings = {
            ...configuredSettings,
            setting_b: { ...worldSettings.setting_b, value: 'final_value' }
        };
        
        // Update mock to return completed settings after the update
        getWorldSettingsSpy.mockReset();
        getWorldSettingsSpy
            .mockResolvedValueOnce(configuredSettings) // Initial call
            .mockResolvedValueOnce(completedSettings); // After update

        await updateSettingsAction.handler!(runtime, message, state, {}, callback);
        
        expect(callback).toHaveBeenCalled();
        const callbackArg = callback.mock.calls[0][0];
        expect(callbackArg.text).toContain('complete');
    });
  });
}); 