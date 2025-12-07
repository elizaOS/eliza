/**
 * @fileoverview Test utilities for core runtime tests
 */

import { mock } from 'bun:test';
import type { IDatabaseAdapter, UUID } from '../types';
import { stringToUuid } from '../utils';

/**
 * Creates a mock database adapter with all required methods
 * Useful for testing runtime initialization without a real database
 * 
 * The mock returns proper values to allow runtime initialization to complete:
 * - Entity operations return valid entities after "creation"
 * - Room operations return valid rooms after "creation"
 * - World operations return valid worlds after "creation"
 */
export function createMockAdapter(): IDatabaseAdapter {
  // Track created entities, rooms, worlds for subsequent queries
  const createdEntities = new Map<UUID, any>();
  const createdRooms = new Map<UUID, any>();
  const createdWorlds = new Map<UUID, any>();

  return {
    init: mock(async () => {}),
    close: mock(async () => {}),
    isReady: mock(async () => true),
    getConnection: mock(async () => ({})),
    getAgent: mock(async () => null),
    getAgents: mock(async () => []),
    createAgent: mock(async () => true),
    updateAgent: mock(async () => true),
    deleteAgent: mock(async () => true),
    ensureEmbeddingDimension: mock(async () => {}),
    log: mock(async () => {}),
    runPluginMigrations: mock(async () => {}),
    
    // Entity operations - return created entities
    getEntitiesByIds: mock(async (ids: UUID[]) => 
      ids.map(id => createdEntities.get(id)).filter(Boolean)
    ),
    getRoomsByIds: mock(async (ids: UUID[]) => 
      ids.map(id => createdRooms.get(id)).filter(Boolean)
    ),
    getEntityByName: mock(async () => null),
    getEntityById: mock(async (id: UUID) => createdEntities.get(id) || null),
    createEntity: mock(async (entity: any) => {
      createdEntities.set(entity.id, entity);
      return true;
    }),
    createEntities: mock(async (entities: any[]) => {
      entities.forEach(entity => createdEntities.set(entity.id, entity));
      return true;
    }),
    
    // Room operations - return created rooms
    getRoom: mock(async (id: UUID) => createdRooms.get(id) || null),
    createRoom: mock(async (room: any) => {
      const roomId = room.id || stringToUuid('test-room') as UUID;
      createdRooms.set(roomId, { ...room, id: roomId });
      return roomId;
    }),
    createRooms: mock(async (rooms: any[]) => {
      return rooms.map(room => {
        const roomId = room.id || stringToUuid(`test-room-${Math.random()}`) as UUID;
        createdRooms.set(roomId, { ...room, id: roomId });
        return roomId;
      });
    }),
    addParticipantsRoom: mock(async () => true),
    getParticipantsForRoom: mock(async () => []),
    
    // World operations - return created worlds
    getWorld: mock(async (id: UUID) => createdWorlds.get(id) || null),
    createWorld: mock(async (world: any) => {
      const worldId = world.id || stringToUuid('test-world') as UUID;
      createdWorlds.set(worldId, { ...world, id: worldId });
      return worldId;
    }),
  } as unknown as IDatabaseAdapter;
}

