import {
  type Component,
  type Entity,
  elizaLogger,
  type IDatabaseAdapter,
  type Memory,
  type Relationship,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { stableSerialize } from "../stable-serialize";

type CompatDatabaseMethod = (...args: any[]) => Promise<any> | any;
type CompatDatabaseAdapter = IDatabaseAdapter & Record<string, unknown>;
type LegacyRelationshipQueryParams = {
  entityId: UUID;
  entityIds: UUID[];
  tags?: string[];
};
type LegacyRelationshipQueryExecutor = (
  params: LegacyRelationshipQueryParams,
) => Promise<Relationship[]>;

function hasAdapterMethod<Name extends string>(
  adapter: CompatDatabaseAdapter,
  name: Name,
): adapter is CompatDatabaseAdapter & Record<Name, CompatDatabaseMethod> {
  return typeof adapter[name] === "function";
}

function defineCompatMethod(
  adapter: CompatDatabaseAdapter,
  name: string,
  implementation: CompatDatabaseMethod,
  addedMethods: string[],
): void {
  if (hasAdapterMethod(adapter, name)) {
    return;
  }

  Object.defineProperty(adapter, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: implementation,
  });
  addedMethods.push(name);
}

function normalizeRelationshipEntityIds(params: { entityIds?: UUID[]; entityId?: UUID }): UUID[] {
  const rawIds =
    Array.isArray(params.entityIds) && params.entityIds.length > 0
      ? params.entityIds
      : params.entityId
        ? [params.entityId]
        : [];

  return rawIds.filter((id): id is UUID => typeof id === "string" && id.trim().length > 0);
}

function wrapRelationshipQueriesForCoreV2(adapter: CompatDatabaseAdapter): boolean {
  if (!hasAdapterMethod(adapter, "getRelationships")) {
    return false;
  }

  const originalGetRelationships = adapter.getRelationships.bind(
    adapter,
  ) as LegacyRelationshipQueryExecutor;

  Object.defineProperty(adapter, "getRelationships", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: async (params: {
      entityIds?: UUID[];
      entityId?: UUID;
      tags?: string[];
      limit?: number;
      offset?: number;
    }): Promise<Relationship[]> => {
      const entityIds = normalizeRelationshipEntityIds(params);
      if (entityIds.length === 0) {
        return [];
      }

      const { limit, offset, ...queryParams } = params;
      const relationships = await Promise.all(
        entityIds.map((entityId) =>
          originalGetRelationships({
            ...queryParams,
            entityId,
            entityIds: [entityId],
          }),
        ),
      );
      const byId = new Map<string, Relationship>();

      for (const relationship of relationships.flat() as Relationship[]) {
        byId.set(String(relationship.id), relationship);
      }

      const result = Array.from(byId.values());
      const start = typeof offset === "number" && offset > 0 ? offset : 0;
      return typeof limit === "number" ? result.slice(start, start + limit) : result.slice(start);
    },
  });

  return true;
}

function makeCompatUuid(...parts: Array<string | UUID | null | undefined>): UUID {
  return stringToUuid(parts.filter(Boolean).join(":")) as UUID;
}

function matchesDataFilter(value: unknown, filter: Record<string, unknown>): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(filter).every(([key, expected]) => {
    const actual = (value as Record<string, unknown>)[key];

    if (Array.isArray(expected)) {
      return (
        Array.isArray(actual) &&
        expected.every((expectedItem) =>
          actual.some(
            (actualItem) => stableSerialize(actualItem) === stableSerialize(expectedItem),
          ),
        )
      );
    }

    if (expected && typeof expected === "object") {
      return matchesDataFilter(actual, expected as Record<string, unknown>);
    }

    return actual === expected;
  });
}

export function applyLegacyDatabaseAdapterCompat(adapter: IDatabaseAdapter): IDatabaseAdapter {
  const compat = adapter as CompatDatabaseAdapter;
  const addedMethods: string[] = [];
  const wrappedMethods: string[] = [];

  if (wrapRelationshipQueriesForCoreV2(compat)) {
    wrappedMethods.push("getRelationships");
  }

  defineCompatMethod(
    compat,
    "transaction",
    async (
      callback: (tx: IDatabaseAdapter) => Promise<unknown>,
      options?: { entityContext?: UUID },
    ) => {
      if (options?.entityContext && hasAdapterMethod(compat, "withIsolationContext")) {
        return compat.withIsolationContext(options.entityContext, async () => callback(compat));
      }

      return callback(compat);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getAgentsByIds",
    async (agentIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "getAgent")) {
        return [];
      }

      const agents = await Promise.all(agentIds.map((agentId) => compat.getAgent(agentId)));
      return agents.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createAgents",
    async (agents: Array<Record<string, unknown> & { id?: UUID }>) => {
      if (!hasAdapterMethod(compat, "createAgent")) {
        return [];
      }

      await Promise.all(agents.map((agent) => compat.createAgent(agent)));
      return agents.flatMap((agent) => (agent.id ? [agent.id] : []));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateAgents",
    async (updates: Array<{ agentId: UUID; agent: Record<string, unknown> }>) => {
      if (!hasAdapterMethod(compat, "updateAgent")) {
        return false;
      }

      await Promise.all(updates.map(({ agentId, agent }) => compat.updateAgent(agentId, agent)));
      return true;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteAgents",
    async (agentIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteAgent")) {
        return false;
      }

      await Promise.all(agentIds.map((agentId) => compat.deleteAgent(agentId)));
      return true;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertAgents",
    async (agents: Array<Record<string, unknown> & { id?: UUID }>) => {
      const existingById = new Map<string, boolean>();

      if (hasAdapterMethod(compat, "getAgentsByIds")) {
        const existingAgents = await compat.getAgentsByIds(
          agents.flatMap((agent) => (agent.id ? [agent.id] : [])),
        );
        for (const existingAgent of existingAgents) {
          const existingId = (existingAgent as { id?: UUID }).id;
          if (existingId) {
            existingById.set(existingId as string, true);
          }
        }
      }

      if (!hasAdapterMethod(compat, "createAgent")) {
        return;
      }

      await Promise.all(
        agents.map(async (agent) => {
          if (!agent.id) {
            await compat.createAgent(agent);
            return;
          }

          if (existingById.has(agent.id as string) && hasAdapterMethod(compat, "updateAgent")) {
            await compat.updateAgent(agent.id, agent);
            return;
          }

          await compat.createAgent(agent);
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getEntitiesForRooms",
    async (roomIds: UUID[], includeComponents?: boolean) => {
      if (!hasAdapterMethod(compat, "getEntitiesForRoom")) {
        return roomIds.map((roomId) => ({ roomId, entities: [] }));
      }

      const entries = await Promise.all(
        roomIds.map(async (roomId) => ({
          roomId,
          entities: await compat.getEntitiesForRoom(roomId, includeComponents),
        })),
      );
      return entries;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateEntities",
    async (entities: Array<Record<string, unknown> & { id: UUID }>) => {
      if (!hasAdapterMethod(compat, "updateEntity")) {
        return;
      }

      await Promise.all(entities.map((entity) => compat.updateEntity(entity as unknown as Entity)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteEntities",
    async (entityIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteEntity")) {
        return;
      }

      await Promise.all(entityIds.map((entityId) => compat.deleteEntity(entityId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertEntities",
    async (entities: Array<Record<string, unknown> & { id?: UUID }>) => {
      const entityIds = entities.flatMap((entity: any) => (entity.id ? [entity.id] : []));
      const existingById = new Set<string>();

      if (hasAdapterMethod(compat, "getEntitiesByIds") && entityIds.length > 0) {
        const existingEntities = await compat.getEntitiesByIds(entityIds);
        for (const existingEntity of existingEntities ?? []) {
          const existingId = (existingEntity as { id?: UUID }).id;
          if (existingId) {
            existingById.add(existingId as string);
          }
        }
      }

      await Promise.all(
        entities.map(async (entity) => {
          if (!entity.id) {
            if (hasAdapterMethod(compat, "createEntities")) {
              await compat.createEntities([entity as any]);
            }
            return;
          }

          if (existingById.has(entity.id as string) && hasAdapterMethod(compat, "updateEntity")) {
            await compat.updateEntity(entity as any);
            return;
          }

          if (hasAdapterMethod(compat, "createEntities")) {
            await compat.createEntities([entity as any]);
          }
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getComponentsByNaturalKeys",
    async (
      keys: Array<{
        entityId: UUID;
        type: string;
        worldId?: UUID;
        sourceEntityId?: UUID;
      }>,
    ) => {
      if (!hasAdapterMethod(compat, "getComponent")) {
        return keys.map(() => null);
      }

      return Promise.all(
        keys.map((key) =>
          compat.getComponent(key.entityId, key.type, key.worldId, key.sourceEntityId),
        ),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getComponentsForEntities",
    async (entityIds: UUID[], worldId?: UUID, sourceEntityId?: UUID) => {
      if (!hasAdapterMethod(compat, "getComponents")) {
        return [];
      }

      const nestedComponents = await Promise.all(
        entityIds.map((entityId) => compat.getComponents(entityId, worldId, sourceEntityId)),
      );
      return nestedComponents.flat();
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createComponents",
    async (components: Array<Record<string, unknown> & { id?: UUID }>) => {
      if (!hasAdapterMethod(compat, "createComponent")) {
        return [];
      }

      await Promise.all(
        components.map((component) => compat.createComponent(component as unknown as Component)),
      );
      return components.flatMap((component) => (component.id ? [component.id] : []));
    },
    addedMethods,
  );

  defineCompatMethod(compat, "getComponentsByIds", async () => [], addedMethods);

  defineCompatMethod(
    compat,
    "updateComponents",
    async (components: Array<Record<string, unknown>>) => {
      if (!hasAdapterMethod(compat, "updateComponent")) {
        return;
      }

      await Promise.all(
        components.map((component) => compat.updateComponent(component as unknown as Component)),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteComponents",
    async (componentIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteComponent")) {
        return;
      }

      await Promise.all(componentIds.map((componentId) => compat.deleteComponent(componentId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertComponents",
    async (
      components: Array<Record<string, unknown> & { entityId: UUID; type: string; id?: UUID }>,
    ) => {
      await Promise.all(
        components.map(async (component) => {
          if (
            hasAdapterMethod(compat, "getComponent") &&
            hasAdapterMethod(compat, "updateComponent") &&
            (await compat.getComponent(
              component.entityId,
              component.type,
              component.worldId as UUID | undefined,
              component.sourceEntityId as UUID | undefined,
            ))
          ) {
            await compat.updateComponent(component as unknown as Component);
            return;
          }

          if (hasAdapterMethod(compat, "createComponent")) {
            await compat.createComponent(component as unknown as Component);
          }
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(compat, "patchComponents", async () => {}, addedMethods);

  defineCompatMethod(
    compat,
    "queryEntities",
    async (params: {
      componentType?: string;
      componentDataFilter?: Record<string, unknown>;
      entityIds?: UUID[];
      worldId?: UUID;
      limit?: number;
      offset?: number;
      includeAllComponents?: boolean;
    }) => {
      const entityIds = params.entityIds ?? [];
      if (entityIds.length === 0 || !hasAdapterMethod(compat, "getEntitiesByIds")) {
        return [];
      }

      const entities = (await compat.getEntitiesByIds(entityIds)) ?? [];
      const filteredEntities = await Promise.all(
        entities.map(async (entity) => {
          if (!hasAdapterMethod(compat, "getComponents")) {
            return entity;
          }

          const allComponents = await compat.getComponents(
            (entity as { id: UUID }).id,
            params.worldId,
          );
          const matchedComponents = allComponents.filter((component: any) => {
            if (
              params.componentType &&
              (component as { type?: string }).type !== params.componentType
            ) {
              return false;
            }

            if (
              params.componentDataFilter &&
              !matchesDataFilter(
                (component as { data?: Record<string, unknown> }).data,
                params.componentDataFilter,
              )
            ) {
              return false;
            }

            return true;
          });

          if (
            (params.componentType || params.componentDataFilter || params.worldId !== undefined) &&
            matchedComponents.length === 0
          ) {
            return null;
          }

          return {
            ...entity,
            components: params.includeAllComponents ? allComponents : matchedComponents,
          };
        }),
      );

      const offset = params.offset ?? 0;
      const limit = params.limit ?? filteredEntities.length;
      return filteredEntities.filter(Boolean).slice(offset, offset + limit);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createLogs",
    async (
      entries: Array<{
        body: Record<string, unknown>;
        entityId: UUID;
        roomId: UUID;
        type: string;
      }>,
    ) => {
      if (!hasAdapterMethod(compat, "log")) {
        return;
      }

      await Promise.all(entries.map((entry) => compat.log(entry)));
    },
    addedMethods,
  );

  defineCompatMethod(compat, "getLogsByIds", async () => [], addedMethods);

  defineCompatMethod(compat, "updateLogs", async () => {}, addedMethods);

  defineCompatMethod(
    compat,
    "deleteLogs",
    async (logIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteLog")) {
        return;
      }

      await Promise.all(logIds.map((logId) => compat.deleteLog(logId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createMemories",
    async (
      entries: Array<{
        memory: Record<string, unknown>;
        tableName: string;
        unique?: boolean;
      }>,
    ) => {
      if (!hasAdapterMethod(compat, "createMemory")) {
        return [];
      }

      const ids = await Promise.all(
        entries.map(({ memory, tableName, unique }) =>
          compat.createMemory(memory as unknown as Memory, tableName, unique),
        ),
      );
      return ids.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateMemories",
    async (memories: Array<Record<string, unknown> & { id: UUID }>) => {
      if (!hasAdapterMethod(compat, "updateMemory")) {
        return;
      }

      await Promise.all(
        memories.map((memory) =>
          compat.updateMemory(memory as unknown as Partial<Memory> & { id: UUID }),
        ),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteMemories",
    async (memoryIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteMemory")) {
        return;
      }

      await Promise.all(memoryIds.map((memoryId) => compat.deleteMemory(memoryId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertMemories",
    async (
      entries: Array<{
        memory: Record<string, unknown> & { id?: UUID };
        tableName: string;
      }>,
    ) => {
      await Promise.all(
        entries.map(async ({ memory, tableName }) => {
          if (
            memory.id &&
            hasAdapterMethod(compat, "getMemoryById") &&
            hasAdapterMethod(compat, "updateMemory") &&
            (await compat.getMemoryById(memory.id))
          ) {
            await compat.updateMemory(memory as unknown as Partial<Memory> & { id: UUID });
            return;
          }

          if (hasAdapterMethod(compat, "createMemory")) {
            await compat.createMemory(memory as unknown as Memory, tableName);
          }
        }),
      );
    },
    addedMethods,
  );

  if (hasAdapterMethod(compat, "deleteAllMemories")) {
    const deleteAllMemories = compat.deleteAllMemories.bind(compat);
    Object.defineProperty(compat, "deleteAllMemories", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: async (roomIdsOrRoomId: UUID[] | UUID, tableName: string) => {
        if (Array.isArray(roomIdsOrRoomId)) {
          await Promise.all(
            roomIdsOrRoomId.map((roomId: UUID) => deleteAllMemories(roomId as any, tableName)),
          );
          return;
        }

        return deleteAllMemories(roomIdsOrRoomId as any, tableName);
      },
    });
  }

  if (hasAdapterMethod(compat, "countMemories")) {
    const countMemories = compat.countMemories.bind(compat);
    Object.defineProperty(compat, "countMemories", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: async (
        roomIdOrParams:
          | UUID
          | {
              roomIds?: UUID[];
              unique?: boolean;
              tableName?: string;
            },
        unique?: boolean,
        tableName?: string,
      ) => {
        if (
          roomIdOrParams &&
          typeof roomIdOrParams === "object" &&
          !Array.isArray(roomIdOrParams)
        ) {
          const params = roomIdOrParams;
          const roomIds = params.roomIds ?? [];
          if (roomIds.length === 0) {
            return 0;
          }

          const counts = await Promise.all(
            roomIds.map((roomId: UUID) =>
              (countMemories as any)(
                roomId,
                params.unique ?? false,
                params.tableName ?? "messages",
              ),
            ),
          );
          return counts.reduce((sum, value) => sum + Number(value ?? 0), 0);
        }

        return (countMemories as any)(roomIdOrParams, unique, tableName);
      },
    });
  }

  defineCompatMethod(
    compat,
    "getWorldsByIds",
    async (worldIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "getWorld")) {
        return [];
      }

      const worlds = await Promise.all(worldIds.map((worldId) => compat.getWorld(worldId)));
      return worlds.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createWorlds",
    async (worlds: Array<Record<string, unknown> & { id?: UUID }>) => {
      if (!hasAdapterMethod(compat, "createWorld")) {
        return [];
      }

      const ids = await Promise.all(
        worlds.map((world) => compat.createWorld(world as unknown as World)),
      );
      return ids.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteWorlds",
    async (worldIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "removeWorld")) {
        return;
      }

      await Promise.all(worldIds.map((worldId) => compat.removeWorld(worldId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateWorlds",
    async (worlds: Array<Record<string, unknown>>) => {
      if (!hasAdapterMethod(compat, "updateWorld")) {
        return;
      }

      await Promise.all(worlds.map((world) => compat.updateWorld(world as unknown as World)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertWorlds",
    async (worlds: Array<Record<string, unknown> & { id?: UUID }>) => {
      const worldIds = worlds.flatMap((world) => (world.id ? [world.id] : []));
      const existingIds = new Set<string>();

      if (hasAdapterMethod(compat, "getWorldsByIds")) {
        const existingWorlds = await compat.getWorldsByIds(worldIds);
        for (const world of existingWorlds) {
          const existingId = (world as { id?: UUID }).id;
          if (existingId) {
            existingIds.add(existingId as string);
          }
        }
      }

      await Promise.all(
        worlds.map(async (world) => {
          if (!world.id) {
            if (hasAdapterMethod(compat, "createWorld")) {
              await compat.createWorld(world as unknown as World);
            }
            return;
          }

          if (existingIds.has(world.id as string) && hasAdapterMethod(compat, "updateWorld")) {
            await compat.updateWorld(world as unknown as World);
            return;
          }

          if (hasAdapterMethod(compat, "createWorld")) {
            await compat.createWorld(world as unknown as World);
          }
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteRoomsByWorldIds",
    async (worldIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteRoomsByWorldId")) {
        return;
      }

      await Promise.all(worldIds.map((worldId) => compat.deleteRoomsByWorldId(worldId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getRoomsByWorlds",
    async (worldIds: UUID[], limit?: number, offset?: number) => {
      if (!hasAdapterMethod(compat, "getRoomsByWorld")) {
        return [];
      }

      const rooms = (
        await Promise.all(worldIds.map((worldId) => compat.getRoomsByWorld(worldId)))
      ).flat();
      const slicedRooms = rooms.slice(offset ?? 0);
      return limit === undefined ? slicedRooms : slicedRooms.slice(0, limit);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateRooms",
    async (rooms: Array<Record<string, unknown>>) => {
      if (!hasAdapterMethod(compat, "updateRoom")) {
        return;
      }

      await Promise.all(rooms.map((room) => compat.updateRoom(room as unknown as Room)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteRooms",
    async (roomIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteRoom")) {
        return;
      }

      await Promise.all(roomIds.map((roomId) => compat.deleteRoom(roomId)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "upsertRooms",
    async (rooms: Array<Record<string, unknown> & { id?: UUID }>) => {
      const existingIds = new Set<string>();

      if (hasAdapterMethod(compat, "getRoomsByIds")) {
        const existingRooms = await compat.getRoomsByIds(
          rooms.flatMap((room) => (room.id ? [room.id] : [])),
        );
        for (const existingRoom of existingRooms ?? []) {
          const existingId = (existingRoom as { id?: UUID }).id;
          if (existingId) {
            existingIds.add(existingId as string);
          }
        }
      }

      await Promise.all(
        rooms.map(async (room) => {
          if (!room.id) {
            if (hasAdapterMethod(compat, "createRooms")) {
              await compat.createRooms([room as any]);
            }
            return;
          }

          if (existingIds.has(room.id as string) && hasAdapterMethod(compat, "updateRoom")) {
            await compat.updateRoom(room as any);
            return;
          }

          if (hasAdapterMethod(compat, "createRooms")) {
            await compat.createRooms([room as any]);
          }
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getParticipantsForEntities",
    async (entityIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "getParticipantsForEntity")) {
        return [];
      }

      const nestedParticipants = await Promise.all(
        entityIds.map((entityId) => compat.getParticipantsForEntity(entityId)),
      );
      return nestedParticipants.flat();
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getParticipantsForRooms",
    async (roomIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "getParticipantsForRoom")) {
        return roomIds.map((roomId) => ({ roomId, entityIds: [] }));
      }

      return Promise.all(
        roomIds.map(async (roomId) => ({
          roomId,
          entityIds: await compat.getParticipantsForRoom(roomId),
        })),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "areRoomParticipants",
    async (pairs: Array<{ roomId: UUID; entityId: UUID }>) => {
      if (!hasAdapterMethod(compat, "isRoomParticipant")) {
        return pairs.map(() => false);
      }

      return Promise.all(
        pairs.map(({ roomId, entityId }) => compat.isRoomParticipant(roomId, entityId)),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createRoomParticipants",
    async (entityIds: UUID[], roomId: UUID) => {
      if (hasAdapterMethod(compat, "addParticipantsRoom")) {
        await compat.addParticipantsRoom(entityIds, roomId);
      }

      return entityIds.map((entityId) => makeCompatUuid(roomId, entityId));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteParticipants",
    async (participants: Array<{ entityId: UUID; roomId: UUID }>) => {
      if (!hasAdapterMethod(compat, "removeParticipant")) {
        return false;
      }

      await Promise.all(
        participants.map(({ entityId, roomId }) => compat.removeParticipant(entityId, roomId)),
      );
      return true;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateParticipants",
    async (
      participants: Array<{
        entityId: UUID;
        roomId: UUID;
        updates: { roomState?: string | null };
      }>,
    ) => {
      if (!hasAdapterMethod(compat, "setParticipantUserState")) {
        return;
      }

      await Promise.all(
        participants.map(async ({ entityId, roomId, updates }) => {
          if (updates.roomState !== undefined) {
            await compat.setParticipantUserState(
              roomId,
              entityId,
              updates.roomState as "FOLLOWED" | "MUTED" | null,
            );
          }
        }),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getParticipantUserStates",
    async (pairs: Array<{ roomId: UUID; entityId: UUID }>) => {
      if (!hasAdapterMethod(compat, "getParticipantUserState")) {
        return pairs.map(() => null);
      }

      return Promise.all(
        pairs.map(({ roomId, entityId }) => compat.getParticipantUserState(roomId, entityId)),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateParticipantUserStates",
    async (updates: Array<{ roomId: UUID; entityId: UUID; state: string | null }>) => {
      if (!hasAdapterMethod(compat, "setParticipantUserState")) {
        return;
      }

      await Promise.all(
        updates.map(({ roomId, entityId, state }) =>
          compat.setParticipantUserState(roomId, entityId, state as "FOLLOWED" | "MUTED" | null),
        ),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getRelationshipsByPairs",
    async (pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>) => {
      if (!hasAdapterMethod(compat, "getRelationship")) {
        return pairs.map(() => null);
      }

      return Promise.all(
        pairs.map(({ sourceEntityId, targetEntityId }) =>
          compat.getRelationship({ sourceEntityId, targetEntityId }),
        ),
      );
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createRelationships",
    async (
      relationships: Array<{
        sourceEntityId: UUID;
        targetEntityId: UUID;
        tags?: string[];
        metadata?: Record<string, unknown>;
      }>,
    ) => {
      if (hasAdapterMethod(compat, "createRelationship")) {
        await Promise.all(
          relationships.map((relationship) =>
            compat.createRelationship(relationship as unknown as Relationship),
          ),
        );
      }

      return relationships.map(({ sourceEntityId, targetEntityId }) =>
        makeCompatUuid(sourceEntityId, targetEntityId, "relationship"),
      );
    },
    addedMethods,
  );

  defineCompatMethod(compat, "getRelationshipsByIds", async () => [], addedMethods);

  defineCompatMethod(
    compat,
    "updateRelationships",
    async (relationships: Array<Record<string, unknown>>) => {
      if (!hasAdapterMethod(compat, "updateRelationship")) {
        return;
      }

      await Promise.all(
        relationships.map((relationship) =>
          compat.updateRelationship(relationship as unknown as Relationship),
        ),
      );
    },
    addedMethods,
  );

  defineCompatMethod(compat, "deleteRelationships", async () => {}, addedMethods);

  defineCompatMethod(
    compat,
    "getCaches",
    async (keys: string[]) => {
      if (!hasAdapterMethod(compat, "getCache")) {
        return new Map();
      }

      const entries = await Promise.all(
        keys.map(async (key) => [key, await compat.getCache(key)] as const),
      );
      return new Map(entries.filter(([, value]) => value !== undefined));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "setCaches",
    async (entries: Array<{ key: string; value: unknown }>) => {
      if (!hasAdapterMethod(compat, "setCache")) {
        return false;
      }

      await Promise.all(entries.map(({ key, value }) => compat.setCache(key, value)));
      return true;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteCaches",
    async (keys: string[]) => {
      if (!hasAdapterMethod(compat, "deleteCache")) {
        return false;
      }

      await Promise.all(keys.map((key) => compat.deleteCache(key)));
      return true;
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "createTasks",
    async (tasks: Array<Record<string, unknown> & { id?: UUID }>) => {
      if (!hasAdapterMethod(compat, "createTask")) {
        return [];
      }

      const ids = await Promise.all(
        tasks.map((task) => compat.createTask(task as unknown as Task)),
      );
      return ids.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "getTasksByIds",
    async (taskIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "getTask")) {
        return [];
      }

      const tasks = await Promise.all(taskIds.map((taskId) => compat.getTask(taskId)));
      return tasks.filter(Boolean);
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "updateTasks",
    async (updates: Array<{ id: UUID; task: Record<string, unknown> }>) => {
      if (!hasAdapterMethod(compat, "updateTask")) {
        return;
      }

      await Promise.all(updates.map(({ id, task }) => compat.updateTask(id, task)));
    },
    addedMethods,
  );

  defineCompatMethod(
    compat,
    "deleteTasks",
    async (taskIds: UUID[]) => {
      if (!hasAdapterMethod(compat, "deleteTask")) {
        return;
      }

      await Promise.all(taskIds.map((taskId) => compat.deleteTask(taskId)));
    },
    addedMethods,
  );

  const shimmedMethods = [...addedMethods, ...wrappedMethods];

  if (shimmedMethods.length > 0) {
    elizaLogger.warn(
      `[RuntimeFactory] Applied database adapter compatibility shim: ${shimmedMethods.join(", ")}`,
    );
  }

  return compat;
}
