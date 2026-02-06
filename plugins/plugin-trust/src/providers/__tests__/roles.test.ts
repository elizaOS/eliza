import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { roleProvider } from '../roles';
import type { IAgentRuntime, Memory, State, UUID, World, Entity } from '@elizaos/core';
import { ChannelType, Role } from '@elizaos/core';

// Mocks
const createMockRuntime = (): IAgentRuntime => ({
    getRoom: vi.fn(),
    getWorld: vi.fn(),
    getEntityById: vi.fn(),
} as any);

const createMockMemory = (channelType: ChannelType, roomId: UUID): Memory => ({
    roomId,
    content: { channelType },
} as Memory);

const mockState: State = { data: {} } as State;

const ownerEntity: Partial<Entity> = { id: 'owner-id' as UUID, names: ['Owner'], metadata: { name: 'Owner', username: 'owner_user' }};
const adminEntity: Partial<Entity> = { id: 'admin-id' as UUID, names: ['Admin'], metadata: { name: 'Admin', username: 'admin_user' }};
const memberEntity: Partial<Entity> = { id: 'member-id' as UUID, names: ['Member'], metadata: { name: 'Member', username: 'member_user' }};

const mockWorld: Partial<World> = {
    metadata: {
        ownership: { ownerId: 'owner-id' as UUID },
        roles: {
            [ownerEntity.id!]: Role.OWNER,
            [adminEntity.id!]: Role.ADMIN,
            [memberEntity.id!]: Role.NONE,
        }
    }
};

describe('roleProvider', () => {
    let runtime: IAgentRuntime;
    const testRoomId = 'room-1' as UUID;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime = createMockRuntime();
    });

    it('should return "no access" message for DM channels', async () => {
        (runtime.getRoom as Mock).mockResolvedValue({ type: ChannelType.DM });
        const memory = createMockMemory(ChannelType.DM, testRoomId);
        
        const result = await roleProvider.get(runtime, memory, mockState);

        expect(result.text).toContain('No access to role information in DMs');
    });

    it('should return "no role info" if world or roles are not found', async () => {
        (runtime.getRoom as Mock).mockResolvedValue({ type: ChannelType.GROUP, serverId: 'server-1' as UUID });
        (runtime.getWorld as Mock).mockResolvedValue(null); // No world
        const memory = createMockMemory(ChannelType.GROUP, testRoomId);

        const result = await roleProvider.get(runtime, memory, mockState);

        expect(result.text).toContain('No role information available');
    });

    it('should correctly format the role hierarchy', async () => {
        (runtime.getRoom as Mock).mockResolvedValue({ type: ChannelType.GROUP, serverId: 'server-1' as UUID });
        (runtime.getWorld as Mock).mockResolvedValue(mockWorld);
        (runtime.getEntityById as Mock).mockImplementation(entityId => {
            if (entityId === ownerEntity.id) return ownerEntity;
            if (entityId === adminEntity.id) return adminEntity;
            if (entityId === memberEntity.id) return memberEntity;
            return null;
        });
        const memory = createMockMemory(ChannelType.GROUP, testRoomId);
        
        const result = await roleProvider.get(runtime, memory, mockState);

        expect(result.text).toContain('# Server Role Hierarchy');
        expect(result.text).toContain('## Owners\nOwner (Owner)');
        expect(result.text).toContain('## Administrators\nAdmin (Admin) (admin_user)');
        expect(result.text).toContain('## Members\nMember (Member) (member_user)');
    });
    
    it('should handle users with no name or username gracefully', async () => {
        const namelessEntity = { id: 'nameless-id' as UUID, names: [] };
        const worldWithNameless = { 
            ...mockWorld,
            metadata: {
                ...mockWorld.metadata,
                roles: { ...mockWorld.metadata!.roles, [namelessEntity.id]: Role.NONE }
            }
        };
        (runtime.getRoom as Mock).mockResolvedValue({ type: ChannelType.GROUP, serverId: 'server-1' as UUID });
        (runtime.getWorld as Mock).mockResolvedValue(worldWithNameless);
        (runtime.getEntityById as Mock).mockImplementation(entityId => {
            if (entityId === namelessEntity.id) return namelessEntity;
            return ownerEntity; // return something to avoid other errors
        });
        const memory = createMockMemory(ChannelType.GROUP, testRoomId);

        const result = await roleProvider.get(runtime, memory, mockState);
        
        // The nameless user should just be skipped, not cause an error
        expect(result.text).not.toContain('undefined');
    });
}); 