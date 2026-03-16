import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { updateRoleAction } from '../roles';
import type { IAgentRuntime, Memory, State, UUID, World, Entity } from '@elizaos/core';
import { ChannelType, ModelType, Role } from '@elizaos/core';

// The function to test is not exported, so we have to copy it here.
// In a real scenario, we would export it for testing.
const canModifyRole = (currentRole: Role, targetRole: Role | null, newRole: Role): boolean => {
  if (targetRole === currentRole) return false;
  switch (currentRole) {
    case Role.OWNER:
      return true;
    case Role.ADMIN:
      return newRole !== Role.OWNER;
    case Role.NONE:
    default:
      return false;
  }
};

// Mocks
const createMockRuntime = (world: World | null): IAgentRuntime =>
  ({
    agentId: 'test-agent' as UUID,
    getSetting: vi.fn().mockReturnValue('world-1'),
    getWorld: vi.fn().mockResolvedValue(world),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    updateWorld: vi.fn().mockResolvedValue(true),
    useModel: vi.fn(),
  } as any);

const createMockMemory = (
  text: string,
  entityId: UUID,
  channelType: ChannelType,
  serverId?: string
): Memory =>
  ({
    entityId,
    roomId: 'room-1' as UUID,
    content: {
      text,
      channelType,
      serverId,
    },
  } as Memory);

const mockEntities: Entity[] = [
    { id: 'user-to-be-admin' as UUID, names: ['NewAdmin'] } as Entity,
    { id: 'user-to-be-owner' as UUID, names: ['NewOwner'] } as Entity,
];

const requesterId = 'requester' as UUID;

const createMockWorld = (requesterRole: Role): World => {
    // Get the first entity safely
    const firstEntity = mockEntities[0];
    if (!firstEntity) throw new Error('Mock entities not initialized');
    
    // Create roles object with proper typing
    const roles: Record<string, Role> = {};
    roles[requesterId] = requesterRole;
    
    // Only set the role if firstEntity.id exists
    if (firstEntity.id) {
        roles[firstEntity.id] = Role.NONE;
    }
    
    return {
        id: 'world-1' as UUID,
        name: 'Test World',
        agentId: 'test-agent' as UUID,
        serverId: 'server-1' as UUID,
        ownerId: 'owner-id' as UUID,
        metadata: {
            roles
        }
    } as World;
};


describe('roles action', () => {
  describe('canModifyRole', () => {
    it('OWNER can change any role', () => {
      expect(canModifyRole(Role.OWNER, Role.ADMIN, Role.OWNER)).toBe(true);
      expect(canModifyRole(Role.OWNER, Role.NONE, Role.ADMIN)).toBe(true);
    });

    it('ADMIN can change roles up to ADMIN', () => {
      expect(canModifyRole(Role.ADMIN, Role.NONE, Role.ADMIN)).toBe(true);
      // ADMIN cannot change another ADMIN's role (same level restriction)
      expect(canModifyRole(Role.ADMIN, Role.ADMIN, Role.NONE)).toBe(false);
    });

    it('ADMIN cannot create an OWNER', () => {
      expect(canModifyRole(Role.ADMIN, Role.NONE, Role.OWNER)).toBe(false);
    });

    it('NONE role cannot modify any roles', () => {
      expect(canModifyRole(Role.NONE, Role.ADMIN, Role.NONE)).toBe(false);
    });

    it('a user cannot change their own role', () => {
      expect(canModifyRole(Role.OWNER, Role.OWNER, Role.ADMIN)).toBe(false);
    });
  });

  describe('updateRoleAction', () => {
    let runtime: IAgentRuntime;
    
    describe('validate', () => {
        it('should return true for group channel with serverId', async () => {
            const memory = createMockMemory('test', requesterId, ChannelType.GROUP, 'server-1');
            const isValid = await updateRoleAction.validate!(runtime, memory);
            expect(isValid).toBe(true);
        });

        it('should return false for DM channel', async () => {
            const memory = createMockMemory('test', requesterId, ChannelType.DM, 'server-1');
            const isValid = await updateRoleAction.validate!(runtime, memory);
            expect(isValid).toBe(false);
        });
    });

    describe('handler', () => {
        const state: State = { text: 'test', values: {} } as State;
        const callback = vi.fn();

        beforeEach(() => {
            vi.clearAllMocks();
            callback.mockClear();
        });

        it('should successfully assign a role when requester is OWNER', async () => {
            const world = createMockWorld(Role.OWNER);
            runtime = createMockRuntime(world);
            (runtime.getEntitiesForRoom as Mock).mockResolvedValue(mockEntities);
            (runtime.useModel as Mock).mockResolvedValue([{ entityId: mockEntities[0]!.id, newRole: Role.ADMIN }]);
            
            const memory = createMockMemory('make NewAdmin an admin', requesterId, ChannelType.GROUP, 'server-1');

            await updateRoleAction.handler!(runtime, memory, state, {}, callback);

            expect(runtime.updateWorld).toHaveBeenCalledOnce();
            const updatedWorld = (runtime.updateWorld as Mock).mock.calls[0][0];
            const firstEntityId = mockEntities[0]?.id;
            if (firstEntityId && updatedWorld.metadata?.roles) {
                expect(updatedWorld.metadata.roles[firstEntityId]).toBe(Role.ADMIN);
            }
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                text: `Updated ${mockEntities[0]?.names[0]}'s role to ADMIN.`
            }));
        });

        it('should fail to assign OWNER role when requester is ADMIN', async () => {
            const world = createMockWorld(Role.ADMIN);
            runtime = createMockRuntime(world);
            (runtime.getEntitiesForRoom as Mock).mockResolvedValue(mockEntities);
            (runtime.useModel as Mock).mockResolvedValue([{ entityId: mockEntities[0]!.id, newRole: Role.OWNER }]);

            const memory = createMockMemory('make NewAdmin an owner', requesterId, ChannelType.GROUP, 'server-1');

            await updateRoleAction.handler!(runtime, memory, state, {}, callback);
            
            expect(runtime.updateWorld).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                text: `You don't have permission to change ${mockEntities[0]!.names[0]}'s role to OWNER.`
            }));
        });
        
        it('should inform user when no role assignments are found', async () => {
            const world = createMockWorld(Role.OWNER);
            runtime = createMockRuntime(world);
            (runtime.useModel as Mock).mockResolvedValue([]); // LLM finds nothing

            const memory = createMockMemory('some random text', requesterId, ChannelType.GROUP, 'server-1');

            await updateRoleAction.handler!(runtime, memory, state, {}, callback);

            expect(runtime.updateWorld).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                text: 'No valid role assignments found in the request.'
            }));
        });
    });
  });
}); 