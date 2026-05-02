/**
 * Runtime Factory - Creates configured elizaOS runtimes per user/agent context.
 */
import { createHash } from "node:crypto";
import {
  AgentRuntime,
  type Character,
  type Component,
  type Entity,
  elizaLogger,
  type IDatabaseAdapter,
  type Logger,
  type Memory,
  type Plugin,
  type Relationship,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import * as sqlPluginNode from "@elizaos/plugin-sql";

import { DEFAULT_IMAGE_MODEL } from "@/lib/models";
import { getRequestContext } from "@/lib/services/entity-settings/request-context";
import { logger } from "@/lib/utils/logger";
import { agentLoader } from "./agent-loader";
import { buildElevenLabsSettings, getDefaultModels, getElizaCloudApiUrl } from "./config";
import mcpPlugin from "./plugin-mcp";
import { registerRuntimeCacheActions } from "./runtime-cache-registry";
import type { UserContext } from "./user-context";
import "@/lib/polyfills/dom-polyfills";
import {
  edgeRuntimeCache,
  getStaticEmbeddingDimension,
  KNOWN_EMBEDDING_DIMENSIONS,
} from "@/lib/cache/edge-runtime-cache";
import { resolveRuntimeDatabaseAdapterConfig } from "./database-adapter-config";

const adapterEmbeddingDimensions = new Map<string, number>();
const requestContextGetSettingPatched = Symbol("requestContextGetSettingPatched");

type RuntimeWithRequestContextPatch = AgentRuntime & {
  [requestContextGetSettingPatched]?: true;
};

const createDatabaseAdapter = (
  sqlPluginNode as unknown as {
    createDatabaseAdapter: (
      config: { dataDir?: string; postgresUrl?: string },
      agentId: UUID,
    ) => IDatabaseAdapter;
  }
).createDatabaseAdapter;

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

function applyLegacyDatabaseAdapterCompat(adapter: IDatabaseAdapter): IDatabaseAdapter {
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

function assertPersistentDatabaseRequired(
  runtime: Pick<AgentRuntime, "getSetting" | "agentId">,
): void {
  const raw = runtime.getSetting("ALLOW_NO_DATABASE") ?? process.env.ALLOW_NO_DATABASE;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    throw new Error(
      `Agent cloud requires persistent database storage and does not permit ALLOW_NO_DATABASE (agent ${runtime.agentId}). Remove ALLOW_NO_DATABASE from config/env and keep plugin-sql configured.`,
    );
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Default agent ID used when no specific character/agent is specified.
 * Exported for use in other modules that need the same default.
 */
export const DEFAULT_AGENT_ID_STRING = "b850bc30-45f8-0041-a00a-83df46d8555d";

const MCP_SERVER_CONFIGS: Record<string, { url: string; type: string }> = {
  google: { url: "/api/mcps/google/streamable-http", type: "streamable-http" },
  hubspot: {
    url: "/api/mcps/hubspot/streamable-http",
    type: "streamable-http",
  },
  github: { url: "/api/mcps/github/streamable-http", type: "streamable-http" },
  notion: { url: "/api/mcps/notion/streamable-http", type: "streamable-http" },
  linear: { url: "/api/mcps/linear/streamable-http", type: "streamable-http" },
  asana: { url: "/api/mcps/asana/streamable-http", type: "streamable-http" },
  dropbox: {
    url: "/api/mcps/dropbox/streamable-http",
    type: "streamable-http",
  },
  salesforce: {
    url: "/api/mcps/salesforce/streamable-http",
    type: "streamable-http",
  },
  airtable: {
    url: "/api/mcps/airtable/streamable-http",
    type: "streamable-http",
  },
  zoom: { url: "/api/mcps/zoom/streamable-http", type: "streamable-http" },
  jira: { url: "/api/mcps/jira/streamable-http", type: "streamable-http" },
  linkedin: {
    url: "/api/mcps/linkedin/streamable-http",
    type: "streamable-http",
  },
  microsoft: {
    url: "/api/mcps/microsoft/streamable-http",
    type: "streamable-http",
  },
  twitter: {
    url: "/api/mcps/twitter/streamable-http",
    type: "streamable-http",
  },
};

interface GlobalWithEliza {
  logger?: Logger;
}

interface RuntimeSettings {
  ELIZAOS_API_KEY?: string;
  ELIZAOS_CLOUD_API_KEY?: string;
  USER_ID?: string;
  ENTITY_ID?: string;
  ORGANIZATION_ID?: string;
  IS_ANONYMOUS?: boolean;
  ELIZAOS_CLOUD_NANO_MODEL?: string;
  ELIZAOS_CLOUD_SMALL_MODEL?: string;
  ELIZAOS_CLOUD_MEDIUM_MODEL?: string;
  ELIZAOS_CLOUD_LARGE_MODEL?: string;
  ELIZAOS_CLOUD_MEGA_MODEL?: string;
  ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL?: string;
  ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL?: string;
  ELIZAOS_CLOUD_ACTION_PLANNER_MODEL?: string;
  ELIZAOS_CLOUD_PLANNER_MODEL?: string;
  ELIZAOS_CLOUD_RESPONSE_MODEL?: string;
  ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL?: string;
  ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL?: string;
  appPromptConfig?: unknown;
  [key: string]: unknown;
}

const globalAny = globalThis as GlobalWithEliza;
const DEFAULT_RUNTIME_LIFECYCLE_TIMEOUT_MS = 10_000;

interface CachedRuntime {
  runtime: AgentRuntime;
  lastUsed: number;
  createdAt: number;
  agentId: UUID;
  characterName: string;
  /** MCP config version at creation time (for cross-instance invalidation) */
  mcpVersion: number;
}

function getRuntimeLifecycleTimeoutMs(): number {
  const configured = Number.parseInt(process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RUNTIME_LIFECYCLE_TIMEOUT_MS;
}

async function runWithLifecycleTimeout(
  operation: Promise<void>,
  action: string,
  label: string,
  id: string,
): Promise<void> {
  const timeoutMs = getRuntimeLifecycleTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        elizaLogger.warn(`[${label}] ${action} timed out after ${timeoutMs}ms for ${id}`);
        resolve();
      }, timeoutMs);
      (timeout as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

const safeClose = async (
  closeable: { close(): Promise<void> },
  label: string,
  id: string,
): Promise<void> => {
  const closeOperation = closeable
    .close()
    .catch((e) => elizaLogger.debug(`[${label}] Close error for ${id}: ${e}`));
  await runWithLifecycleTimeout(closeOperation, "Close", label, id);
};

/** Stop runtime services without closing the shared database adapter pool. */
async function stopRuntimeServices(
  runtime: AgentRuntime,
  id: string,
  label: string,
): Promise<void> {
  const stopOperation = runtime
    .stop()
    .catch((e) => elizaLogger.debug(`[${label}] Stop error for ${id}: ${e}`));
  await runWithLifecycleTimeout(stopOperation, "Stop", label, id);
}

class RuntimeCache {
  private cache = new Map<string, CachedRuntime>();
  private readonly MAX_SIZE = 50;
  private readonly MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes max age
  private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle timeout

  private isStale(entry: CachedRuntime, now: number): boolean {
    return now - entry.createdAt > this.MAX_AGE_MS || now - entry.lastUsed > this.IDLE_TIMEOUT_MS;
  }

  private async evictEntry(key: string, entry: CachedRuntime, reason: string): Promise<void> {
    await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
    this.cache.delete(key);
    elizaLogger.debug(`[RuntimeCache] Evicted ${reason} runtime: ${key} (adapter kept alive)`);
  }

  async get(agentId: string): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      // Remove adapter reference for stale entries (consistent with getWithHealthCheck)
      dbAdapterPool.removeAdapter(entry.agentId as string);
      return null;
    }

    entry.lastUsed = now;
    return entry.runtime;
  }

  async getWithHealthCheck(
    agentId: string,
    dbPool: DbAdapterPool,
    currentMcpVersion?: number,
  ): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      // Remove adapter reference for stale entries (checkHealth not called yet)
      dbPool.removeAdapter(entry.agentId as string);
      return null;
    }

    // Cross-instance MCP version check: evict if OAuth changed on another instance
    if (currentMcpVersion !== undefined && entry.mcpVersion < currentMcpVersion) {
      elizaLogger.info(
        `[RuntimeCache] MCP version stale: cached=${entry.mcpVersion}, current=${currentMcpVersion}, key=${agentId}`,
      );
      await this.evictEntry(agentId, entry, "mcp-version-stale");
      dbPool.removeAdapter(entry.agentId as string);
      return null;
    }

    // checkHealth() removes the adapter internally if unhealthy
    const isHealthy = await dbPool.checkHealth(entry.agentId as UUID);
    if (!isHealthy) {
      await this.evictEntry(agentId, entry, "unhealthy");
      return null;
    }

    entry.lastUsed = now;
    return entry.runtime;
  }

  async set(
    cacheKey: string,
    runtime: AgentRuntime,
    characterName: string,
    actualAgentId: UUID,
    mcpVersion: number = 0,
  ): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.MAX_SIZE) {
      await this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(cacheKey, {
      runtime,
      lastUsed: now,
      createdAt: now,
      agentId: actualAgentId,
      characterName,
      mcpVersion,
    });
    elizaLogger.debug(
      `[RuntimeCache] Cached runtime: ${characterName} (${actualAgentId}, key=${cacheKey}, mcpVersion=${mcpVersion})`,
    );
  }

  /** Remove runtime from cache (keeps adapter pool alive). */
  async remove(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (!entry) return false;

    await stopRuntimeServices(entry.runtime, agentId, "RuntimeCache");
    this.cache.delete(agentId);
    elizaLogger.info(`[RuntimeCache] Removed runtime: ${agentId} (adapter kept alive)`);
    return true;
  }

  async removeByAgentId(agentId: string): Promise<number> {
    const keys = Array.from(this.cache.keys()).filter(
      (key) => key === agentId || key.startsWith(`${agentId}:`),
    );

    await Promise.all(keys.map((key) => this.remove(key)));
    return keys.length;
  }

  /** Delete runtime and close completely. Use only for full shutdown. */
  async delete(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (entry) {
      await stopRuntimeServices(entry.runtime, agentId, "RuntimeCache");
      await safeClose(entry.runtime, "RuntimeCache", agentId);
      this.cache.delete(agentId);
      elizaLogger.info(`[RuntimeCache] Deleted runtime: ${agentId} (fully closed)`);
      return true;
    }
    return false;
  }

  has(agentId: string): boolean {
    // Cache keys are now composite: ${agentId}:${orgId}${webSearchSuffix}
    // Check if any key starts with this agentId
    for (const key of this.cache.keys()) {
      if (key.startsWith(agentId)) {
        return true;
      }
    }
    return false;
  }

  private async evictOldest(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestKey = key;
        oldestTime = entry.lastUsed;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        await this.evictEntry(oldestKey, entry, "oldest");
      }
    }
  }

  getStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.MAX_SIZE };
  }

  /** Remove all runtimes for an organization. */
  async removeByOrganization(organizationId: string): Promise<number> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!organizationId || !UUID_RE.test(organizationId)) {
      return 0;
    }

    const entries = Array.from(this.cache.entries()).filter(([key]) =>
      key.includes(`:${organizationId}`),
    );

    await Promise.all(
      entries.map(async ([key, entry]) => {
        await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
        this.cache.delete(key);
        dbAdapterPool.removeAdapter(entry.agentId as string);
      }),
    );

    return entries.length;
  }

  /** Clear all cached runtimes. WARNING: Closes shared connection pool. */
  async clear(): Promise<void> {
    const entries = Array.from(this.cache.entries());
    await Promise.all(
      entries.map(([id, entry]) => stopRuntimeServices(entry.runtime, id, "RuntimeCache")),
    );
    await Promise.all(entries.map(([id, entry]) => safeClose(entry.runtime, "RuntimeCache", id)));
    this.cache.clear();
  }
}

class DbAdapterPool {
  private adapters = new Map<string, IDatabaseAdapter>();
  private initPromises = new Map<string, Promise<IDatabaseAdapter>>();

  async getOrCreate(agentId: UUID, embeddingModel?: string): Promise<IDatabaseAdapter> {
    const key = agentId as string;

    if (this.adapters.has(key)) {
      const existingAdapter = this.adapters.get(key)!;
      const isHealthy = await this.checkAdapterHealth(existingAdapter);
      if (isHealthy) {
        return existingAdapter;
      }

      // Don't close the adapter - it shares a global connection pool.
      // Just remove our reference and let plugin-sql handle pool recreation.
      this.adapters.delete(key);
      adapterEmbeddingDimensions.delete(key);
      elizaLogger.warn(
        `[DbAdapterPool] Stale adapter for ${agentId}, recreating (pool kept alive)`,
      );
    }

    if (this.initPromises.has(key)) {
      return this.initPromises.get(key)!;
    }

    const initPromise = this.createAdapter(agentId, embeddingModel);
    this.initPromises.set(key, initPromise);

    try {
      const adapter = await initPromise;
      this.adapters.set(key, adapter);
      return adapter;
    } finally {
      this.initPromises.delete(key);
    }
  }

  private async checkAdapterHealth(adapter: IDatabaseAdapter): Promise<boolean> {
    try {
      await adapter.getEntitiesByIds(["00000000-0000-0000-0000-000000000000" as UUID]);
      return true;
    } catch (error) {
      // Any error during health check indicates an unhealthy adapter.
      // A non-existent entity should return an empty array, not throw.
      elizaLogger.warn(
        `[DbAdapterPool] Adapter health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async checkHealth(agentId: UUID): Promise<boolean> {
    const key = agentId as string;
    const adapter = this.adapters.get(key);
    if (!adapter) return false;

    const isHealthy = await this.checkAdapterHealth(adapter);
    if (!isHealthy) this.removeAdapter(key);
    return isHealthy;
  }

  private async createAdapter(agentId: UUID, embeddingModel?: string): Promise<IDatabaseAdapter> {
    const startTime = Date.now();
    const adapterConfig = resolveRuntimeDatabaseAdapterConfig(process.env);
    const adapter = applyLegacyDatabaseAdapterCompat(createDatabaseAdapter(adapterConfig, agentId));
    await adapter.initialize();

    const key = agentId as string;
    const dimension = getStaticEmbeddingDimension(embeddingModel);
    const existingDimension = adapterEmbeddingDimensions.get(key);

    if (existingDimension !== dimension) {
      try {
        await adapter.ensureEmbeddingDimension(dimension);
        adapterEmbeddingDimensions.set(key, dimension);
        elizaLogger.info(`[DbAdapterPool] Set embedding dimension for ${agentId}: ${dimension}`);
      } catch (e) {
        elizaLogger.debug(`[DbAdapterPool] Embedding dimension: ${e}`);
        adapterEmbeddingDimensions.set(key, dimension);
      }
    }

    elizaLogger.debug(
      `[DbAdapterPool] Created adapter for ${agentId} in ${Date.now() - startTime}ms`,
    );
    return adapter;
  }

  /** Remove adapter reference without closing the shared connection pool. */
  removeAdapter(agentId: string): void {
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
    elizaLogger.debug(
      `[DbAdapterPool] Removed adapter reference: ${agentId} (connection pool kept alive)`,
    );
  }

  /** Close adapter completely. WARNING: Closes shared connection pool! */
  async closeAdapter(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId);
    if (adapter) {
      await safeClose(adapter, "DbAdapterPool", agentId);
    }
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
  }
}

const runtimeCache = new RuntimeCache();
const dbAdapterPool = new DbAdapterPool();

export class RuntimeFactory {
  private static instance: RuntimeFactory;
  private readonly DEFAULT_AGENT_ID = stringToUuid(DEFAULT_AGENT_ID_STRING) as UUID;

  private constructor() {
    this.initializeLoggers();
  }

  static getInstance(): RuntimeFactory {
    if (!RuntimeFactory.instance) {
      RuntimeFactory.instance = new RuntimeFactory();
    }
    return RuntimeFactory.instance;
  }

  getCacheStats(): { runtime: { size: number; maxSize: number } } {
    return { runtime: runtimeCache.getStats() };
  }

  async clearCaches(): Promise<void> {
    await runtimeCache.clear();
  }

  async invalidateRuntime(agentId: string): Promise<boolean> {
    // Don't close adapter - it shares a global connection pool with all agents
    const removedCount = await runtimeCache.removeByAgentId(agentId);
    const wasInMemory = removedCount > 0;

    // Just remove from our tracking - DON'T close the adapter
    dbAdapterPool.removeAdapter(agentId);

    try {
      await edgeRuntimeCache.invalidateCharacter(agentId);
      await edgeRuntimeCache.markRuntimeWarm(agentId, {
        isWarm: false,
        embeddingDimension: 0,
        characterName: undefined,
      });
    } catch (e) {
      elizaLogger.warn(`[RuntimeFactory] Edge cache invalidation failed: ${e}`);
    }

    elizaLogger.info(
      `[RuntimeFactory] Invalidated runtime for agent: ${agentId} (entries: ${removedCount})`,
    );

    return wasInMemory;
  }

  isRuntimeCached(agentId: string): boolean {
    return runtimeCache.has(agentId);
  }

  /** Invalidate all runtimes for an organization (e.g., when OAuth changes). */
  async invalidateByOrganization(organizationId: string): Promise<number> {
    const count = await runtimeCache.removeByOrganization(organizationId);
    if (count > 0) {
      elizaLogger.info(
        `[RuntimeFactory] Invalidated ${count} runtime(s) for org ${organizationId}`,
      );
    }
    return count;
  }

  async createRuntimeForUser(context: UserContext): Promise<AgentRuntime> {
    const startTime = Date.now();
    elizaLogger.info(
      `[RuntimeFactory] Creating runtime: user=${context.userId}, mode=${context.agentMode}, char=${context.characterId || "default"}, webSearch=${context.webSearchEnabled}`,
    );

    const isDefaultCharacter = !context.characterId === DEFAULT_AGENT_ID_STRING;
    const loaderOptions = { webSearchEnabled: context.webSearchEnabled };

    const { character, plugins, modeResolution } = isDefaultCharacter
      ? await agentLoader.getDefaultCharacter(context.agentMode, loaderOptions)
      : await agentLoader.loadCharacter(context.characterId!, context.agentMode, loaderOptions);

    if (modeResolution.upgradeReason !== "none") {
      elizaLogger.info(
        `[RuntimeFactory] Mode upgraded: ${context.agentMode} → ${modeResolution.mode} (reason: ${modeResolution.upgradeReason})`,
      );
    }

    const agentId = (character.id ? stringToUuid(character.id) : this.DEFAULT_AGENT_ID) as UUID;

    const webSearchSuffix = context.webSearchEnabled ? ":ws" : "";
    // Include MCP-relevant OAuth platforms so runtime is recreated when user connects
    // e.g. HubSpot; otherwise a cached runtime created with only Google never gets HubSpot tools
    const connectedMcp = this.getConnectedPlatforms(context);
    const mcpPlatforms = Object.keys(MCP_SERVER_CONFIGS).filter((p) => connectedMcp.has(p));
    const mcpSuffix = mcpPlatforms.length > 0 ? `:mcp=${mcpPlatforms.sort().join(",")}` : "";
    const directContextSignature = this.buildDirectAccessContextSignature(context);
    const contextSuffix = directContextSignature ? `:ctx=${directContextSignature}` : "";
    // Include organizationId to prevent cross-org API key pollution
    const cacheKey = `${agentId}:${context.organizationId}${webSearchSuffix}${mcpSuffix}${contextSuffix}`;

    // Check cross-instance MCP config version (non-blocking fetch, falls back to 0)
    const currentMcpVersion = await edgeRuntimeCache
      .getMcpVersion(context.organizationId)
      .catch(() => 0);

    const cachedRuntime = await runtimeCache.getWithHealthCheck(
      cacheKey,
      dbAdapterPool,
      currentMcpVersion,
    );
    if (cachedRuntime) {
      elizaLogger.info(
        `[RuntimeFactory] Cache HIT: ${character.name} (${Date.now() - startTime}ms)`,
      );
      this.applyUserContext(cachedRuntime, context);
      edgeRuntimeCache.incrementRequestCount(agentId as string).catch((e) => {
        elizaLogger.debug(`[RuntimeFactory] Edge cache increment failed: ${e}`);
      });

      return cachedRuntime;
    }

    elizaLogger.info(`[RuntimeFactory] Cache MISS: ${character.name}`);

    const embeddingModel =
      (character.settings?.OPENAI_EMBEDDING_MODEL as string) ||
      (character.settings?.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);

    const dbAdapter = await dbAdapterPool.getOrCreate(agentId, embeddingModel);
    const baseSettings = this.buildSettings(character, context);
    const filteredPlugins = this.filterPlugins(plugins);

    // Build MCP settings from user's OAuth connections
    // Pass character.settings to preserve any pre-configured MCP servers
    const mcpSettings = this.buildMcpSettings(character.settings || {}, context);

    // Add MCP plugin if user has OAuth connections for any MCP server
    // This is necessary because plugin loading happens before MCP settings injection
    if (this.shouldEnableMcp(context) && !filteredPlugins.some((p) => p.name === "mcp")) {
      filteredPlugins.push(mcpPlugin as Plugin);
      elizaLogger.info("[RuntimeFactory] Added MCP plugin for OAuth-connected user");
    }

    // MCP settings go into character.settings so plugin-mcp can find them
    // via runtime.character.settings.mcp (getSetting() drops object types).
    // Runtime cache is in-memory only — these won't be persisted to DB.
    const settingsWithMcp = mcpSettings.mcp
      ? { ...baseSettings, mcp: mcpSettings.mcp }
      : baseSettings;

    // User-specific settings that should NOT be persisted to the database
    // These are passed via opts.settings so they're ephemeral per-request
    const ephemeralSettings: Record<string, string | boolean | number | Record<string, unknown>> = {
      // API keys - must be per-user, not persisted
      ELIZAOS_API_KEY: context.apiKey,
      ELIZAOS_CLOUD_API_KEY: context.apiKey,
      // User context - must be per-user, not persisted
      USER_ID: context.userId,
      ENTITY_ID: context.entityId,
      ORGANIZATION_ID: context.organizationId,
      IS_ANONYMOUS: context.isAnonymous,
    };

    // Create runtime with user-specific settings in opts.settings (NOT character.settings)
    // runtime.getSetting() checks opts.settings as fallback, and these won't be persisted to DB
    // Note: Nested objects (like MCP settings) are JSON.stringified to preserve them
    const runtimeSettings: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(ephemeralSettings).map(([key, value]) => [
        key,
        typeof value === "string"
          ? value
          : value === null || value === undefined
            ? undefined
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value),
      ]),
    );
    const runtime = new AgentRuntime({
      character: {
        ...character,
        id: agentId,
        settings: settingsWithMcp as any,
      },
      plugins: filteredPlugins,
      agentId,
      settings: runtimeSettings,
    });

    runtime.registerDatabaseAdapter(dbAdapter);
    this.ensureRuntimeLogger(runtime);

    await this.initializeRuntime(runtime, character, agentId);
    await this.waitForMcpServiceIfNeeded(runtime, filteredPlugins);

    this.setMcpEnabledServers(context);

    await runtimeCache.set(cacheKey, runtime, character.name ?? "", agentId, currentMcpVersion);

    edgeRuntimeCache
      .markRuntimeWarm(agentId as string, {
        isWarm: true,
        embeddingDimension: getStaticEmbeddingDimension(embeddingModel),
        characterName: character.name,
      })
      .catch((e) => {
        elizaLogger.debug(`[RuntimeFactory] Edge cache warm failed: ${e}`);
      });

    elizaLogger.success(
      `[RuntimeFactory] Runtime ready: ${character.name} (${modeResolution.mode}, webSearch=${context.webSearchEnabled}) in ${Date.now() - startTime}ms`,
    );
    return runtime;
  }

  /**
   * Apply user-specific context to a cached runtime.
   *
   * IMPORTANT: API keys, user IDs, and other settings resolved via getSetting()
   * are handled by the Cloud request context in services/entity-settings/request-context.ts.
   * Those settings are prefetched at request start and injected via runWithRequestContext(),
   * so getSetting() returns the correct user's values without mutating shared state.
   *
   * This method only handles settings that are accessed DIRECTLY on character.settings
   * (not via getSetting()), such as model preferences and app configurations.
   */
  private applyUserContext(runtime: AgentRuntime, context: UserContext): void {
    const charSettings = (runtime.character.settings || {}) as RuntimeSettings;

    // Model preferences - accessed directly, not via getSetting().
    // The cache key includes a signature of these direct-access settings, so a
    // cache hit here only re-applies the same effective values.
    if (context.modelPreferences) {
      charSettings.ELIZAOS_CLOUD_NANO_MODEL =
        context.modelPreferences.nanoModel || charSettings.ELIZAOS_CLOUD_NANO_MODEL;
      charSettings.ELIZAOS_CLOUD_SMALL_MODEL =
        context.modelPreferences.smallModel || charSettings.ELIZAOS_CLOUD_SMALL_MODEL;
      charSettings.ELIZAOS_CLOUD_MEDIUM_MODEL =
        context.modelPreferences.mediumModel || charSettings.ELIZAOS_CLOUD_MEDIUM_MODEL;
      charSettings.ELIZAOS_CLOUD_LARGE_MODEL =
        context.modelPreferences.largeModel || charSettings.ELIZAOS_CLOUD_LARGE_MODEL;
      charSettings.ELIZAOS_CLOUD_MEGA_MODEL =
        context.modelPreferences.megaModel || charSettings.ELIZAOS_CLOUD_MEGA_MODEL;
      charSettings.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL =
        context.modelPreferences.responseHandlerModel ||
        context.modelPreferences.shouldRespondModel ||
        charSettings.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
      charSettings.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL =
        context.modelPreferences.shouldRespondModel ||
        context.modelPreferences.responseHandlerModel ||
        charSettings.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
      charSettings.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL =
        context.modelPreferences.actionPlannerModel ||
        context.modelPreferences.plannerModel ||
        charSettings.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
      charSettings.ELIZAOS_CLOUD_PLANNER_MODEL =
        context.modelPreferences.plannerModel ||
        context.modelPreferences.actionPlannerModel ||
        charSettings.ELIZAOS_CLOUD_PLANNER_MODEL;
      charSettings.ELIZAOS_CLOUD_RESPONSE_MODEL =
        context.modelPreferences.responseModel || charSettings.ELIZAOS_CLOUD_RESPONSE_MODEL;
      charSettings.ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL =
        context.modelPreferences.mediaDescriptionModel ||
        charSettings.ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL;
    }

    // Image model - accessed directly
    if (context.imageModel) {
      charSettings.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL = context.imageModel;
    }

    // App prompt config - accessed directly
    if (context.appPromptConfig) {
      charSettings.appPromptConfig = context.appPromptConfig;
    }

    // MCP settings: NO LONGER mutated on shared runtime.
    // Previously we wrote to charSettings.mcp here, causing race conditions
    // when concurrent users shared the same cached runtime (API key leakage).
    //
    // Instead, we store the user's enabled MCP server names in request context.
    // validate() in dynamic-tool-actions.ts checks this to filter tools per-user.
    // Auth (X-API-Key) is injected dynamically by McpService.createHttpTransport()
    // via getSetting("ELIZAOS_API_KEY") which reads from request context.
    this.setMcpEnabledServers(context);

    // NOTE: The following are NO LONGER mutated here because they're resolved
    // dynamically via getSetting() which checks request context first:
    // - ELIZAOS_API_KEY / ELIZAOS_CLOUD_API_KEY
    // - USER_ID / ENTITY_ID / ORGANIZATION_ID / IS_ANONYMOUS
    // - MCP settings (now via MCP_ENABLED_SERVERS in request context)
    //
    // See: packages/core/src/runtime.ts getSetting() and
    //      lib/services/entity-settings/service.ts prefetch()
  }

  /**
   * Transform MCP settings: resolve relative URLs to absolute.
   *
   * IMPORTANT: Does NOT inject X-API-Key headers. Auth is handled dynamically
   * by McpService.createHttpTransport() via getSetting("ELIZAOS_API_KEY"),
   * which reads from request context for per-user isolation.
   */
  private transformMcpSettings(mcpSettings: Record<string, unknown>): Record<string, unknown> {
    if (!mcpSettings?.servers) return mcpSettings;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const transformedServers: Record<string, unknown> = {};

    for (const [serverId, serverConfig] of Object.entries(
      mcpSettings.servers as Record<
        string,
        { url?: string; type?: string; headers?: Record<string, string> } | null
      >,
    )) {
      if (!serverConfig) continue;
      const transformedUrl = serverConfig.url?.startsWith("/")
        ? `${baseUrl}${serverConfig.url}`
        : serverConfig.url;

      transformedServers[serverId] = {
        ...serverConfig,
        url: transformedUrl,
      };
    }

    return { ...mcpSettings, servers: transformedServers };
  }

  private getConnectedPlatforms(context: UserContext): Set<string> {
    return new Set((context.oauthConnections || []).map((c) => c.platform.toLowerCase()));
  }

  private shouldEnableMcp(context: UserContext): boolean {
    const connected = this.getConnectedPlatforms(context);
    return Object.keys(MCP_SERVER_CONFIGS).some((p) => connected.has(p));
  }

  /**
   * Set MCP_ENABLED_SERVERS in request context so validate() in
   * dynamic-tool-actions.ts can filter tools per-user on every path.
   */
  private setMcpEnabledServers(context: UserContext): void {
    const requestCtx = getRequestContext();
    if (!requestCtx) return;
    const connected = this.getConnectedPlatforms(context);
    const enabledServers = Object.keys(MCP_SERVER_CONFIGS).filter((p) => connected.has(p));
    requestCtx.entitySettings.set("MCP_ENABLED_SERVERS", JSON.stringify(enabledServers));
  }

  private buildMcpSettings(
    _charSettings: Record<string, unknown>,
    context: UserContext,
  ): { mcp?: Record<string, unknown> } {
    const connected = this.getConnectedPlatforms(context);
    const enabledServers = Object.fromEntries(
      Object.entries(MCP_SERVER_CONFIGS).filter(([p]) => connected.has(p)),
    );

    if (Object.keys(enabledServers).length === 0) return {};

    elizaLogger.debug(`[RuntimeFactory] MCP enabled: ${Object.keys(enabledServers).join(", ")}`);

    // Only use servers from MCP_SERVER_CONFIGS — don't merge with DB-stored
    // server configs which can contain stale full URLs from previous ngrok sessions
    return {
      mcp: this.transformMcpSettings({ servers: enabledServers }),
    };
  }

  private filterPlugins(plugins: Plugin[]): Plugin[] {
    return plugins.filter((p) => p.name !== "@elizaos/plugin-sql") as Plugin[];
  }

  private buildDirectAccessContextSignature(context: UserContext): string {
    const signatureSource = {
      modelPreferences: context.modelPreferences ?? null,
      imageModel: context.imageModel ?? null,
      appPromptConfig: context.appPromptConfig ?? null,
    };

    if (
      !signatureSource.modelPreferences &&
      !signatureSource.imageModel &&
      !signatureSource.appPromptConfig
    ) {
      return "";
    }

    return createHash("sha1").update(stableSerialize(signatureSource)).digest("hex").slice(0, 16);
  }

  private buildSettings(
    character: Character,
    context: UserContext,
  ): NonNullable<Character["settings"]> {
    // Strip user-specific and ephemeral settings from charSettings
    // These should NOT come from persisted DB values - they must be fresh per-request
    const {
      mcp: _stripMcp,
      ELIZAOS_API_KEY: _stripApiKey,
      ELIZAOS_CLOUD_API_KEY: _stripCloudApiKey,
      USER_ID: _stripUserId,
      ENTITY_ID: _stripEntityId,
      ORGANIZATION_ID: _stripOrgId,
      IS_ANONYMOUS: _stripIsAnon,
      ...charSettings
    } = (character.settings || {}) as Record<string, unknown>;

    const getSetting = (key: string, fallback: string) =>
      (charSettings[key] as string) || process.env[key] || fallback;

    const embeddingModel =
      (charSettings.OPENAI_EMBEDDING_MODEL as string) ||
      (charSettings.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);
    const embeddingDimension = getStaticEmbeddingDimension(embeddingModel);

    // Return character-level settings with stale DB values stripped.
    // MCP is stripped here and re-injected fresh by createRuntimeForUser/applyUserContext.
    return {
      ...charSettings,
      POSTGRES_URL: process.env.DATABASE_URL!,
      DATABASE_URL: process.env.DATABASE_URL!,
      EMBEDDING_DIMENSION: String(embeddingDimension),
      ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
      ELIZAOS_CLOUD_NANO_MODEL:
        context.modelPreferences?.nanoModel ||
        getSetting(
          "ELIZAOS_CLOUD_NANO_MODEL",
          getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
        ),
      ELIZAOS_CLOUD_MEDIUM_MODEL:
        context.modelPreferences?.mediumModel ||
        getSetting(
          "ELIZAOS_CLOUD_MEDIUM_MODEL",
          getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
        ),
      ELIZAOS_CLOUD_SMALL_MODEL:
        context.modelPreferences?.smallModel ||
        getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
      ELIZAOS_CLOUD_LARGE_MODEL:
        context.modelPreferences?.largeModel ||
        getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
      ELIZAOS_CLOUD_MEGA_MODEL:
        context.modelPreferences?.megaModel ||
        getSetting(
          "ELIZAOS_CLOUD_MEGA_MODEL",
          getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
        ),
      ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL:
        context.modelPreferences?.responseHandlerModel ||
        context.modelPreferences?.shouldRespondModel ||
        getSetting(
          "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
          getSetting(
            "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
            context.modelPreferences?.nanoModel ||
              context.modelPreferences?.smallModel ||
              getSetting("ELIZAOS_CLOUD_NANO_MODEL", getDefaultModels().small),
          ),
        ),
      ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL:
        context.modelPreferences?.shouldRespondModel ||
        context.modelPreferences?.responseHandlerModel ||
        getSetting(
          "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
          getSetting(
            "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
            context.modelPreferences?.nanoModel ||
              context.modelPreferences?.smallModel ||
              getSetting("ELIZAOS_CLOUD_NANO_MODEL", getDefaultModels().small),
          ),
        ),
      ELIZAOS_CLOUD_ACTION_PLANNER_MODEL:
        context.modelPreferences?.actionPlannerModel ||
        context.modelPreferences?.plannerModel ||
        getSetting(
          "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
          getSetting(
            "ELIZAOS_CLOUD_PLANNER_MODEL",
            context.modelPreferences?.mediumModel ||
              context.modelPreferences?.smallModel ||
              getSetting("ELIZAOS_CLOUD_MEDIUM_MODEL", getDefaultModels().small),
          ),
        ),
      ELIZAOS_CLOUD_PLANNER_MODEL:
        context.modelPreferences?.plannerModel ||
        context.modelPreferences?.actionPlannerModel ||
        getSetting(
          "ELIZAOS_CLOUD_PLANNER_MODEL",
          getSetting(
            "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
            context.modelPreferences?.mediumModel ||
              context.modelPreferences?.smallModel ||
              getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
          ),
        ),
      ELIZAOS_CLOUD_RESPONSE_MODEL:
        context.modelPreferences?.responseModel ||
        getSetting(
          "ELIZAOS_CLOUD_RESPONSE_MODEL",
          context.modelPreferences?.largeModel ||
            getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
        ),
      ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL:
        context.modelPreferences?.mediaDescriptionModel ||
        getSetting("ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL", "google/gemini-2.5-flash-lite"),
      ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL:
        context.imageModel ||
        getSetting("ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", DEFAULT_IMAGE_MODEL.modelId),
      ...buildElevenLabsSettings(charSettings),
      // NOTE: User-specific API keys and context are passed via opts.settings
      // MCP is stripped here and re-injected via settingsWithMcp in createRuntimeForUser
      ...(context.appPromptConfig ? { appPromptConfig: context.appPromptConfig } : {}),
      ...(context.webSearchEnabled
        ? {
            ...(process.env.GOOGLE_API_KEY ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } : {}),
            ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
            ...(process.env.GOOGLE_GENERATIVE_AI_API_KEY
              ? { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY }
              : {}),
          }
        : {}),
    } as unknown as NonNullable<Character["settings"]>;
  }

  private async initializeRuntime(
    runtime: AgentRuntime,
    character: Character,
    agentId: UUID,
  ): Promise<void> {
    const startTime = Date.now();

    let initSucceeded = false;
    try {
      const initStart = Date.now();
      assertPersistentDatabaseRequired(runtime);
      await runtime.initialize({ skipMigrations: true });
      elizaLogger.info(`[RuntimeFactory] initialize() completed in ${Date.now() - initStart}ms`);
      initSucceeded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isDuplicate =
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("unique constraint") ||
        msg.includes("Failed to create entity") ||
        msg.includes("Failed to create agent") ||
        msg.includes("Failed to create room");
      if (!isDuplicate) throw e;
      elizaLogger.warn(`[RuntimeFactory] Init error: ${msg.substring(0, 50)}...`);
      this.resolveInitPromise(runtime);
    }

    // Check if agent exists
    const agentExists = await runtime.getAgent(agentId);

    const parallelOps: Promise<void>[] = [];

    if (!agentExists) {
      parallelOps.push(this.ensureAgentExists(runtime, character, agentId));
    }

    parallelOps.push(
      (async () => {
        try {
          await runtime.ensureWorldExists({
            id: agentId,
            name: `World for ${character.name}`,
            agentId,
            serverId: agentId,
          } as World);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            !msg.toLowerCase().includes("duplicate") &&
            !msg.toLowerCase().includes("unique constraint")
          ) {
            throw e;
          }
        }
      })(),
    );

    if (parallelOps.length > 0) {
      const parallelStart = Date.now();
      await Promise.all(parallelOps);
      elizaLogger.debug(`[RuntimeFactory] Parallel ops: ${Date.now() - parallelStart}ms`);
    }

    if (initSucceeded) {
      this.resolveInitPromise(runtime);
    }

    elizaLogger.info(`[RuntimeFactory] Init: ${Date.now() - startTime}ms`);
  }

  private resolveInitPromise(runtime: AgentRuntime): void {
    const runtimeAny = runtime as unknown as {
      initResolver?: () => void;
    };
    if (typeof runtimeAny.initResolver === "function") {
      runtimeAny.initResolver();
      runtimeAny.initResolver = undefined;
    }
  }

  private async ensureAgentExists(
    runtime: AgentRuntime,
    character: Character,
    agentId: UUID,
  ): Promise<void> {
    try {
      await runtime.createEntity({
        id: agentId,
        names: [character.name || "Eliza"],
        agentId,
        metadata: { name: character.name || "Eliza" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.toLowerCase().includes("duplicate") &&
        !msg.toLowerCase().includes("unique constraint")
      )
        throw e;
    }
  }

  private ensureRuntimeLogger(runtime: AgentRuntime): void {
    const runtimeWithPatch = runtime as RuntimeWithRequestContextPatch;
    if (!runtimeWithPatch[requestContextGetSettingPatched]) {
      const baseGetSetting = runtime.getSetting.bind(runtime);
      runtime.getSetting = ((key: string) => {
        const requestCtx = getRequestContext();
        if (requestCtx?.entitySettings.has(key)) {
          return requestCtx.entitySettings.get(key) ?? null;
        }
        const runtimeSettings = Reflect.get(runtime, "settings");
        if (
          runtimeSettings &&
          typeof runtimeSettings === "object" &&
          Object.hasOwn(runtimeSettings, key)
        ) {
          return (runtimeSettings as Record<string, string | undefined>)[key] ?? null;
        }
        return baseGetSetting(key);
      }) as AgentRuntime["getSetting"];
      runtimeWithPatch[requestContextGetSettingPatched] = true;
    }

    if (!runtime.logger?.log) {
      runtime.logger = {
        log: logger.info.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
        success: (message: string) => logger.info(`✓ ${message}`),
        notice: console.info.bind(console),
      } as Logger & { notice: typeof console.info };
    }
  }

  private initializeLoggers(): void {
    if (elizaLogger) {
      elizaLogger.log = logger.info.bind(console);
      elizaLogger.info = console.info.bind(console);
      elizaLogger.warn = console.warn.bind(console);
      elizaLogger.error = console.error.bind(console);
      elizaLogger.debug = console.debug.bind(console);
      elizaLogger.success = (obj: string | Error | Record<string, unknown>, msg?: string) => {
        logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
      };
    }

    if (typeof globalThis !== "undefined" && !globalAny.logger) {
      globalAny.logger = {
        level: "info",
        log: logger.info.bind(console),
        trace: console.trace.bind(console),
        debug: console.debug.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        fatal: console.error.bind(console),
        success: (obj: string | Error | Record<string, unknown>, msg?: string) => {
          logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
        },
        progress: logger.info.bind(console),
        clear: () => console.clear(),
        child: () => globalAny.logger!,
      };
    }
  }

  private async waitForMcpServiceIfNeeded(runtime: AgentRuntime, plugins: Plugin[]): Promise<void> {
    if (!plugins.some((p) => p.name === "mcp")) return;

    type McpService = {
      waitForInitialization?: () => Promise<void>;
      getServers?: () => unknown[];
    };

    const startTime = Date.now();
    const maxWaitMs = 15000; // Allow time for MCP server connections (dev cold start can take ~10s)
    const maxDelay = 200;
    let waitMs = 5; // Start lower at 5ms
    let mcpService: McpService | null = null;

    // Check immediately first
    mcpService = runtime.getService("mcp") as McpService | null;

    // Exponential backoff: 5, 10, 20, 40, 80, 160, 200, 200...
    while (!mcpService && Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, waitMs));
      mcpService = runtime.getService("mcp") as McpService | null;
      waitMs = Math.min(waitMs * 2, maxDelay);
    }

    const elapsed = Date.now() - startTime;
    if (!mcpService) {
      elizaLogger.warn(`[RuntimeFactory] MCP service not available after ${elapsed}ms`);
      return;
    }

    elizaLogger.debug(`[RuntimeFactory] MCP service found in ${elapsed}ms`);

    if (typeof mcpService.waitForInitialization === "function") {
      await mcpService.waitForInitialization();
    }

    const servers = mcpService.getServers?.();
    if (servers) {
      elizaLogger.info(
        `[RuntimeFactory] MCP: ${servers.length} server(s) connected in ${Date.now() - startTime}ms`,
      );
      for (const server of servers as Array<{
        name: string;
        status: string;
        tools?: unknown[];
        error?: string;
      }>) {
        elizaLogger.info(
          `[RuntimeFactory] MCP Server: ${server.name} status=${server.status} tools=${server.tools?.length || 0} error=${server.error || "none"}`,
        );
      }
    }
  }
}

export const runtimeFactory = RuntimeFactory.getInstance();

registerRuntimeCacheActions({
  invalidateRuntime: (agentId: string) => runtimeFactory.invalidateRuntime(agentId),
  invalidateByOrganization: (organizationId: string) =>
    runtimeFactory.invalidateByOrganization(organizationId),
});

export function getRuntimeCacheStats(): {
  runtime: { size: number; maxSize: number };
} {
  return runtimeFactory.getCacheStats();
}

export async function invalidateRuntime(agentId: string): Promise<boolean> {
  return runtimeFactory.invalidateRuntime(agentId);
}

export function isRuntimeCached(agentId: string): boolean {
  return runtimeFactory.isRuntimeCached(agentId);
}

/** Invalidate all cached runtimes for an organization. */
export async function invalidateByOrganization(organizationId: string): Promise<number> {
  return runtimeFactory.invalidateByOrganization(organizationId);
}

export { getStaticEmbeddingDimension, KNOWN_EMBEDDING_DIMENSIONS };

// Test exports - only for integration testing
export const _testing = {
  getRuntimeCache: () => runtimeCache,
  getDbAdapterPool: () => dbAdapterPool,
  safeClose,
  stopRuntimeServices,

  async forceEvictRuntime(agentId: string): Promise<void> {
    await runtimeCache.removeByAgentId(agentId);
  },

  async forceEvictRuntimeOld(agentId: string): Promise<void> {
    const keys = Array.from(runtimeCache["cache"].keys()).filter(
      (key) => key === agentId || key.startsWith(`${agentId}:`),
    );
    for (const key of keys) {
      const entry = runtimeCache["cache"].get(key);
      if (entry) {
        // Stop services first so background polling loops don't fire on the closed pool
        await stopRuntimeServices(entry.runtime, key, "TestForceEvictOld");
        await safeClose(entry.runtime, "TestForceEvictOld", key);
        runtimeCache["cache"].delete(key);
      }
    }
    // Remove the now-closed adapter so subsequent tests create a fresh pool
    dbAdapterPool["adapters"].delete(agentId);
  },

  getCacheEntries(): Map<string, { runtime: AgentRuntime; lastUsed: number; createdAt: number }> {
    return new Map(runtimeCache["cache"]);
  },

  getAdapterEntries(): Map<string, IDatabaseAdapter> {
    return new Map(dbAdapterPool["adapters"]);
  },

  async closeAdapterDirectly(agentId: string): Promise<void> {
    // Stop background services first so test failures come from the closed pool,
    // not from unrelated polling loops racing after the adapter is gone.
    const matchingEntries = Array.from(runtimeCache["cache"].entries()).filter(
      ([, entry]) => (entry.agentId as string) === agentId,
    );

    for (const [cacheKey, entry] of matchingEntries) {
      await stopRuntimeServices(entry.runtime, cacheKey, "TestCloseAdapterDirectly");
    }

    // Wait for any in-flight withRetry backoff timers (baseDelay=1000ms, up to 2 retries)
    // to exhaust before closing the pool. Without this, retry callbacks fire during
    // subsequent tests and throw "Cannot use a pool after calling end" as unhandled rejections.
    await new Promise((r) => setTimeout(r, 3500));

    await dbAdapterPool.closeAdapter(agentId);
  },
};
