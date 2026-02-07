import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { settingsProvider } from '../settings';
import type { IAgentRuntime, Memory, State, UUID, WorldSettings, World } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';
import * as core from '@elizaos/core';

// Create spies for the core functions
const findWorldsForOwnerSpy = vi.spyOn(core, 'findWorldsForOwner');
const getWorldSettingsSpy = vi.spyOn(core, 'getWorldSettings');

const createMockRuntime = (): IAgentRuntime => ({
  character: { name: 'TestAgent' },
  getRoom: vi.fn(),
  getWorld: vi.fn(),
  updateWorld: vi.fn(),
} as any);

const createMockMemory = (channelType: ChannelType, entityId: UUID, roomId: UUID): Memory => ({
  entityId,
  roomId,
  content: { channelType },
} as Memory);

const mockState: State = {} as State;

const createMockSettings = (allSet: boolean): WorldSettings => ({
  setting_a: { name: 'Setting A', description: 'First one', usageDescription: 'desc a', required: true, value: allSet ? 'done' : null },
  setting_b: { name: 'Setting B', description: 'Second one', usageDescription: 'desc b', required: false, value: null },
});

describe('settingsProvider', () => {
  let runtime: IAgentRuntime;
  const testEntityId = 'user-1' as UUID;
  const testRoomId = 'room-1' as UUID;
  const testWorldId = 'world-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
  });

  describe('Onboarding (DM) context', () => {
    beforeEach(() => {
      (runtime.getRoom as Mock).mockResolvedValue({
        id: testRoomId,
        type: ChannelType.DM,
        worldId: testWorldId,
      });

      const mockWorld: Partial<World> = {
          id: testWorldId,
          serverId: 'server-1' as UUID,
          metadata: { settings: createMockSettings(false) }
      };
      findWorldsForOwnerSpy.mockResolvedValue([mockWorld] as World[]);
    });

    it('should prompt for required settings when they are not configured', async () => {
      const memory = createMockMemory(ChannelType.DM, testEntityId, testRoomId);
      getWorldSettingsSpy.mockResolvedValue(createMockSettings(false));

      const result = await settingsProvider.get(runtime, memory, mockState);
      
      expect(result.text).toContain('PRIORITY TASK: Onboarding');
      expect(result.text).toContain('needs to help the user configure 1 required settings');
      expect(result.values!.settings).toContain('setting_a: Not set (Required)');
    });
    
    it('should show completion message when all required settings are configured', async () => {
      const memory = createMockMemory(ChannelType.DM, testEntityId, testRoomId);
      getWorldSettingsSpy.mockResolvedValue(createMockSettings(true));

      const result = await settingsProvider.get(runtime, memory, mockState);
      
      expect(result.text).toContain('All required settings have been configured');
      expect(result.values!.settings).toContain('setting_a: done (Required)');
    });
  });
  
  describe('Non-Onboarding (Group) context', () => {
    it('should return a summary of public settings', async () => {
        (runtime.getRoom as Mock).mockResolvedValue({
            id: testRoomId,
            type: ChannelType.GROUP,
            worldId: testWorldId,
        });
        (runtime.getWorld as Mock).mockResolvedValue({ serverId: 'server-1' as UUID});
        getWorldSettingsSpy.mockResolvedValue(createMockSettings(true));
        const memory = createMockMemory(ChannelType.GROUP, testEntityId, testRoomId);

        const result = await settingsProvider.get(runtime, memory, mockState);

        expect(result.text).toContain('Current Configuration');
        expect(result.text).toContain('All required settings are configured.');
        expect(result.values!.settings).toContain('Value:** done');
        expect(result.values!.settings).not.toContain('PRIORITY TASK');
    });
  });
}); 