import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mock, spyOn } from 'bun:test';
import { getUserServerRole, findWorldsForOwner } from '../roles';
import { Role, type IAgentRuntime, type UUID, type World } from '../types';
import * as entities from '../entities';
import * as logger_module from '../logger';

describe('roles utilities', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mock.restore();

    // Set up scoped mocks for this test
    spyOn(entities, 'createUniqueUuid').mockImplementation(
      (_runtime, serverId) => `unique-${serverId}` as UUID
    );

    // Mock logger if it doesn't have the methods
    if (logger_module.logger) {
      const methods = ['error', 'info', 'warn', 'debug'];
      methods.forEach((method) => {
        if (typeof logger_module.logger[method] === 'function') {
          spyOn(logger_module.logger, method).mockImplementation(() => {});
        } else {
          logger_module.logger[method] = mock(() => {});
        }
      });
    }

    mockRuntime = {
      agentId: 'agent-123' as UUID,
      getWorld: mock(),
      getAllWorlds: mock(),
    } as unknown as IAgentRuntime;
  });

  afterEach(() => {
    mock.restore();
  });

  describe('getUserServerRole', () => {
    it('should return role from world metadata', async () => {
      const mockWorld: World = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-123' as UUID,
        serverId: 'server-123',
        metadata: {
          roles: {
            ['user-123-456-789-abc-def012345678' as UUID]: Role.ADMIN,
          },
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const role = await getUserServerRole(
        mockRuntime,
        'user-123-456-789-abc-def012345678',
        'server-123'
      );
      expect(role).toBe(Role.ADMIN);
    });

    it('should return Role.NONE when world is null', async () => {
      (mockRuntime.getWorld as any).mockResolvedValue(null);

      const role = await getUserServerRole(mockRuntime, 'user-123', 'server-123');
      expect(role).toBe(Role.NONE);
    });

    it('should return Role.NONE when world has no metadata', async () => {
      const mockWorld: World = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-123' as UUID,
        serverId: 'server-123',
        metadata: {},
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const role = await getUserServerRole(mockRuntime, 'user-123', 'server-123');
      expect(role).toBe(Role.NONE);
    });

    it('should return Role.NONE when world has no roles in metadata', async () => {
      const mockWorld: World = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-123' as UUID,
        serverId: 'server-123',
        metadata: {
          someOtherData: 'value',
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const role = await getUserServerRole(mockRuntime, 'user-123', 'server-123');
      expect(role).toBe(Role.NONE);
    });

    it('should check original ID format when first check fails', async () => {
      const mockWorld: World = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-123' as UUID,
        serverId: 'server-123',
        metadata: {
          roles: {
            ['user-456-789-abc-def-012345678901' as UUID]: Role.OWNER,
          },
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      // Even though the code has duplicate checks for entityId, it should return NONE
      // since 'user-123' is not in the roles
      const role = await getUserServerRole(mockRuntime, 'user-123', 'server-123');
      expect(role).toBe(Role.NONE);
    });

    it('should return role for different role types', async () => {
      const mockWorld: World = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-123' as UUID,
        serverId: 'server-123',
        metadata: {
          roles: {
            ['owner-user-123-456-789-abcdef0123' as UUID]: Role.OWNER,
            ['admin-user-123-456-789-abcdef0123' as UUID]: Role.ADMIN,
            ['none-user-123-456-789-abcdef01234' as UUID]: Role.NONE,
          },
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const ownerRole = await getUserServerRole(
        mockRuntime,
        'owner-user-123-456-789-abcdef0123',
        'server-123'
      );
      expect(ownerRole).toBe(Role.OWNER);

      const adminRole = await getUserServerRole(
        mockRuntime,
        'admin-user-123-456-789-abcdef0123',
        'server-123'
      );
      expect(adminRole).toBe(Role.ADMIN);

      const noneRole = await getUserServerRole(
        mockRuntime,
        'none-user-123-456-789-abcdef01234',
        'server-123'
      );
      expect(noneRole).toBe(Role.NONE);
    });
  });

  describe('findWorldsForOwner', () => {
    it('should find worlds where user is owner', async () => {
      const mockWorlds: World[] = [
        {
          id: 'world-1' as UUID,
          name: 'World 1',
          agentId: 'agent-123' as UUID,
          serverId: 'server-1',
          metadata: {
            ownership: {
              ownerId: 'user-123',
            },
          },
        },
        {
          id: 'world-2' as UUID,
          name: 'World 2',
          agentId: 'agent-123' as UUID,
          serverId: 'server-2',
          metadata: {
            ownership: {
              ownerId: 'other-user',
            },
          },
        },
        {
          id: 'world-3' as UUID,
          name: 'World 3',
          agentId: 'agent-123' as UUID,
          serverId: 'server-3',
          metadata: {
            ownership: {
              ownerId: 'user-123',
            },
          },
        },
      ];

      (mockRuntime.getAllWorlds as any).mockResolvedValue(mockWorlds);

      const ownerWorlds = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(ownerWorlds).toBeDefined();
      expect(ownerWorlds?.length).toBe(2);
      expect(ownerWorlds?.[0].id).toBe('world-1' as UUID);
      expect(ownerWorlds?.[1].id).toBe('world-3' as UUID);
    });

    it('should return null when entityId is empty', async () => {
      const { logger } = await import('../logger');

      const result = await findWorldsForOwner(mockRuntime, '');

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('User ID is required to find server');
    });

    it('should return null when entityId is null', async () => {
      const { logger } = await import('../logger');

      const result = await findWorldsForOwner(mockRuntime, null as any);

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('User ID is required to find server');
    });

    it('should return null when no worlds exist', async () => {
      const { logger } = await import('../logger');

      (mockRuntime.getAllWorlds as any).mockResolvedValue([]);

      const result = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(result).toBeNull();
      expect(logger.info).toHaveBeenCalledWith('No worlds found for this agent');
    });

    it('should return null when getAllWorlds returns null', async () => {
      const { logger } = await import('../logger');

      (mockRuntime.getAllWorlds as any).mockResolvedValue(null);

      const result = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(result).toBeNull();
      expect(logger.info).toHaveBeenCalledWith('No worlds found for this agent');
    });

    it('should return null when no worlds match the owner', async () => {
      const mockWorlds: World[] = [
        {
          id: 'world-1' as UUID,
          name: 'World 1',
          agentId: 'agent-123' as UUID,
          serverId: 'server-1',
          metadata: {
            ownership: {
              ownerId: 'other-user-1',
            },
          },
        },
        {
          id: 'world-2' as UUID,
          name: 'World 2',
          agentId: 'agent-123' as UUID,
          serverId: 'server-2',
          metadata: {
            ownership: {
              ownerId: 'other-user-2',
            },
          },
        },
      ];

      (mockRuntime.getAllWorlds as any).mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(result).toBeNull();
    });

    it('should handle worlds without metadata', async () => {
      const mockWorlds: World[] = [
        {
          id: 'world-1' as UUID,
          name: 'World 1',
          agentId: 'agent-123' as UUID,
          serverId: 'server-1',
          metadata: {},
        },
        {
          id: 'world-2' as UUID,
          name: 'World 2',
          agentId: 'agent-123' as UUID,
          serverId: 'server-2',
        } as World,
      ];

      (mockRuntime.getAllWorlds as any).mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(result).toBeNull();
    });

    it('should handle worlds without ownership in metadata', async () => {
      const mockWorlds: World[] = [
        {
          id: 'world-1' as UUID,
          name: 'World 1',
          agentId: 'agent-123' as UUID,
          serverId: 'server-1',
          metadata: {
            someOtherData: 'value',
          },
        },
      ];

      (mockRuntime.getAllWorlds as any).mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(mockRuntime, 'user-123');

      expect(result).toBeNull();
    });
  });
});
