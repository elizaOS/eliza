import {
  type Agent,
  type Component,
  DatabaseAdapter,
  type Entity,
  type Memory,
  type MemoryMetadata,
  type Participant,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
  type Log,
  logger,
} from '@elizaos/core';
import {
  Column,
  and,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { v4 } from 'uuid';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from './schema/embedding';
import {
  agentTable,
  cacheTable,
  componentTable,
  embeddingTable,
  entityTable,
  logTable,
  memoryTable,
  participantTable,
  relationshipTable,
  roomTable,
  taskTable,
  worldTable,
} from './schema/index';
import type { DrizzleOperations } from './types';

// Define the metadata type inline since we can't import it
/**
 * Represents metadata information about memory.
 * @typedef {Object} MemoryMetadata
 * @property {string} type - The type of memory.
 * @property {string} [source] - The source of the memory.
 * @property {UUID} [sourceId] - The ID of the source.
 * @property {string} [scope] - The scope of the memory.
 * @property {number} [timestamp] - The timestamp of the memory.
 * @property {string[]} [tags] - The tags associated with the memory.
 * @property {UUID} [documentId] - The ID of the document associated with the memory.
 * @property {number} [position] - The position of the memory.
 */

/**
 * Abstract class representing a base Drizzle adapter for working with databases.
 * This adapter provides a comprehensive set of methods for interacting with a database
 * using Drizzle ORM. It implements the DatabaseAdapter interface and handles operations
 * for various entity types including agents, entities, components, memories, rooms,
 * participants, relationships, tasks, and more.
 *
 * The adapter includes built-in retry logic for database operations, embedding dimension
 * management, and transaction support. Concrete implementations must provide the
 * withDatabase method to execute operations against their specific database.
 *
 * @template TDatabase - The type of Drizzle operations supported by the adapter.
 */
export abstract class BaseDrizzleAdapter<
  TDatabase extends DrizzleOperations,
> extends DatabaseAdapter<TDatabase> {
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;
  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  protected agentId: UUID;

  /**
   * Constructor for creating a new instance of Agent with the specified agentId.
   *
   * @param {UUID} agentId - The unique identifier for the agent.
   */
  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.maxRetries) {
          const backoffDelay = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);

          const jitter = Math.random() * this.jitterMax;
          const delay = backoffDelay + jitter;

          logger.warn(`Database operation failed (attempt ${attempt}/${this.maxRetries}):`, {
            error: error instanceof Error ? error.message : String(error),
            nextRetryIn: `${(delay / 1000).toFixed(1)}s`,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error('Max retry attempts reached:', {
            error: error instanceof Error ? error.message : String(error),
            totalAttempts: attempt,
          });
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  /**
   * Asynchronously ensures that an agent exists by checking if an agent with the same name already exists in the system.
   * If the agent does not exist, it will be created with the provided data.
   *
   * @param {Partial<Agent>} agent - The partial data of the agent to ensure its existence.
   * @returns {Promise<void>} - A promise that resolves when the agent is successfully ensured.
   * @throws {Error} - If the agent name is not provided or if there is an issue creating the agent.
   */
  async ensureAgentExists(agent: Partial<Agent>): Promise<void> {
    if (!agent.name) {
      throw new Error('Agent name is required');
    }

    const agents = await this.getAgents();
    const existingAgent = agents.find(
      (a: Partial<Agent & { status: string }>) => a.name === agent.name
    );

    if (!existingAgent) {
      await this.createAgent(agent);
    }
  }

  /**
   * Asynchronously ensures that the given embedding dimension is valid for the agent.
   *
   * @param {number} dimension - The dimension to ensure for the embedding.
   * @returns {Promise<void>} - Resolves once the embedding dimension is ensured.
   */
  async ensureEmbeddingDimension(dimension: number) {
    const existingMemory = await this.db
      .select({
        embedding: embeddingTable,
      })
      .from(memoryTable)
      .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
      .where(eq(memoryTable.agentId, this.agentId))
      .limit(1);

    if (existingMemory.length > 0) {
      const usedDimension = Object.entries(DIMENSION_MAP).find(
        ([_, colName]) => existingMemory[0].embedding[colName] !== null
      );
    }

    this.embeddingDimension = DIMENSION_MAP[dimension];
  }

  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (result.length === 0) return null;
      return result[0];
    });
  }

  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Agent[]>} A Promise that resolves to an array of Agent objects.
   */
  async getAgents(): Promise<Agent[]> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(agentTable);

      return result;
    });
  }

  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(agentTable).values({
            ...agent,
          });
        });

        logger.debug('Agent created successfully:', {
          agentId: agent.id,
        });
        return true;
      } catch (error) {
        logger.error('Error creating agent:', {
          error: error instanceof Error ? error.message : String(error),
          agentId: agent.id,
          agent,
        });
        return false;
      }
    });
  }

  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        if (!agent.id) {
          throw new Error('Agent ID is required for update');
        }

        await this.db.transaction(async (tx) => {
          await tx
            .update(agentTable)
            .set({
              ...agent,
              updatedAt: Date.now(),
            })
            .where(eq(agentTable.id, agentId));
        });

        logger.debug('Agent updated successfully:', {
          agentId,
        });
        return true;
      } catch (error) {
        logger.error('Error updating agent:', {
          error: error instanceof Error ? error.message : String(error),
          agentId,
          agent,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    // casacade delete all related for the agent
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(agentTable).where(eq(agentTable.id, agentId));
      });
      return true;
    });
  }

  /**
   * Count all agents in the database
   * Used primarily for maintenance and cleanup operations
   */
  /**
   * Asynchronously counts the number of agents in the database.
   * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
   */
  async countAgents(): Promise<number> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.select({ count: count() }).from(agentTable);

        return result[0]?.count || 0;
      } catch (error) {
        logger.error('Error counting agents:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }
    });
  }

  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  async cleanupAgents(): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.delete(agentTable);
        logger.success('Successfully cleaned up agent table');
      } catch (error) {
        logger.error('Error cleaning up agent table:', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves an entity and its components by entity ID.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve.
   * @returns {Promise<Entity | null>} A Promise that resolves to the entity with its components if found, null otherwise.
   */
  async getEntityById(entityId: UUID): Promise<Entity | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          entity: entityTable,
          components: componentTable,
        })
        .from(entityTable)
        .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
        .where(and(eq(entityTable.id, entityId), eq(entityTable.agentId, this.agentId)));

      if (result.length === 0) return null;

      // Group components by entity
      const entity = result[0].entity;
      entity.components = result.filter((row) => row.components).map((row) => row.components);

      return entity;
    });
  }

  /**
   * Asynchronously retrieves all entities for a given room, optionally including their components.
   * @param {UUID} roomId - The unique identifier of the room to get entities for
   * @param {boolean} [includeComponents] - Whether to include component data for each entity
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room
   */
  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const query = this.db
        .select({
          entity: entityTable,
          ...(includeComponents && { components: componentTable }),
        })
        .from(participantTable)
        .leftJoin(
          entityTable,
          and(eq(participantTable.entityId, entityTable.id), eq(entityTable.agentId, this.agentId))
        );

      if (includeComponents) {
        query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
      }

      const result = await query.where(eq(participantTable.roomId, roomId));

      // Group components by entity if includeComponents is true
      const entitiesByIdMap = new Map<UUID, Entity>();

      for (const row of result) {
        if (!row.entity) continue;

        const entityId = row.entity.id as UUID;
        if (!entitiesByIdMap.has(entityId)) {
          const entity: Entity = {
            ...row.entity,
            components: includeComponents ? [] : undefined,
          };
          entitiesByIdMap.set(entityId, entity);
        }

        if (includeComponents && row.components) {
          const entity = entitiesByIdMap.get(entityId);
          if (entity) {
            if (!entity.components) {
              entity.components = [];
            }
            entity.components.push(row.components);
          }
        }
      }

      return Array.from(entitiesByIdMap.values());
    });
  }

  /**
   * Asynchronously creates a new entity in the database.
   * @param {Entity} entity - The entity object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createEntity(entity: Entity): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.insert(entityTable).values(entity);

          logger.debug('Entity created successfully:', {
            entity,
          });

          return true;
        });
      } catch (error) {
        logger.error('Error creating entity:', {
          error: error instanceof Error ? error.message : String(error),
          entityId: entity.id,
          name: entity.metadata?.name,
        });
        // trace the error
        logger.trace(error);
        return false;
      }
    });
  }

  /**
   * Asynchronously ensures an entity exists, creating it if it doesn't
   * @param entity The entity to ensure exists
   * @returns Promise resolving to boolean indicating success
   */
  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    if (!entity.id) {
      logger.error('Entity ID is required for ensureEntityExists');
      return false;
    }

    try {
      const existingEntity = await this.getEntityById(entity.id);

      if (!existingEntity) {
        return await this.createEntity(entity);
      }

      return true;
    } catch (error) {
      logger.error('Error ensuring entity exists:', {
        error: error instanceof Error ? error.message : String(error),
        entityId: entity.id,
      });
      return false;
    }
  }

  /**
   * Asynchronously updates an entity in the database.
   * @param {Entity} entity - The entity object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the entity is updated.
   */
  async updateEntity(entity: Entity): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(entityTable)
        .set(entity)
        .where(and(eq(entityTable.id, entity.id as UUID), eq(entityTable.agentId, entity.agentId)));
    });
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));
      return result.length > 0 ? result[0] : null;
    });
  }

  /**
   * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve components for
   * @param {UUID} [worldId] - Optional world ID to filter components by
   * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by
   * @returns {Promise<Component[]>} A Promise that resolves to an array of components
   */
  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select({
          id: componentTable.id,
          entityId: componentTable.entityId,
          type: componentTable.type,
          data: componentTable.data,
          worldId: componentTable.worldId,
          sourceEntityId: componentTable.sourceEntityId,
          createdAt: componentTable.createdAt,
        })
        .from(componentTable)
        .where(and(...conditions));
      return result;
    });
  }

  /**
   * Asynchronously creates a new component in the database.
   * @param {Component} component - The component object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createComponent(component: Component): Promise<boolean> {
    return this.withDatabase(async () => {
      await this.db.insert(componentTable).values(component);
      return true;
    });
  }

  /**
   * Asynchronously updates an existing component in the database.
   * @param {Component} component - The component object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the component is updated.
   */
  async updateComponent(component: Component): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(componentTable)
        .set(component)
        .where(eq(componentTable.id, component.id));
    });
  }

  /**
   * Asynchronously deletes a component from the database.
   * @param {UUID} componentId - The unique identifier of the component to delete.
   * @returns {Promise<void>} A Promise that resolves when the component is deleted.
   */
  async deleteComponent(componentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID} params.roomId - The ID of the room to retrieve memories for.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @param {number} [params.start] - The start date to retrieve memories from.
   * @param {number} [params.end] - The end date to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    roomId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
  }): Promise<Memory[]> {
    const { entityId, agentId, roomId, tableName, count, unique, start, end } = params;

    if (!tableName) throw new Error('tableName is required');
    if (!roomId && !entityId && !agentId)
      throw new Error('roomId, entityId, or agentId is required');

    return this.withDatabase(async () => {
      const conditions = [eq(memoryTable.type, tableName)];

      if (start) {
        conditions.push(gte(memoryTable.createdAt, start));
      }

      if (entityId) {
        conditions.push(eq(memoryTable.entityId, entityId));
      }

      if (roomId) {
        conditions.push(eq(memoryTable.roomId, roomId));
      }

      if (end) {
        conditions.push(lte(memoryTable.createdAt, end));
      }

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      if (agentId) {
        conditions.push(eq(memoryTable.agentId, agentId));
      }

      const query = this.db
        .select({
          memory: {
            id: memoryTable.id,
            type: memoryTable.type,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
          },
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      const rows = params.count ? await query.limit(params.count) : await query;

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt,
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata,
        embedding: row.embedding ? Array.from(row.embedding) : undefined,
      }));
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
   * @param {string} params.tableName - The name of the table to retrieve memories from.
   * @param {number} [params.limit] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];

      const conditions = [
        eq(memoryTable.type, params.tableName),
        inArray(memoryTable.roomId, params.roomIds),
      ];

      conditions.push(eq(memoryTable.agentId, this.agentId));

      const query = this.db
        .select({
          id: memoryTable.id,
          type: memoryTable.type,
          createdAt: memoryTable.createdAt,
          content: memoryTable.content,
          entityId: memoryTable.entityId,
          agentId: memoryTable.agentId,
          roomId: memoryTable.roomId,
          unique: memoryTable.unique,
          metadata: memoryTable.metadata,
        })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      const rows = params.limit ? await query.limit(params.limit) : await query;

      return rows.map((row) => ({
        id: row.id as UUID,
        createdAt: row.createdAt,
        content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        unique: row.unique,
        metadata: row.metadata,
      })) as Memory[];
    });
  }

  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(eq(memoryTable.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const row = result[0];
      return {
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt,
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        embedding: row.embedding ?? undefined,
      };
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (memoryIds.length === 0) return [];

      const conditions = [inArray(memoryTable.id, memoryIds)];

      if (tableName) {
        conditions.push(eq(memoryTable.type, tableName));
      }

      const rows = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt,
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata,
        embedding: row.embedding ?? undefined,
      }));
    });
  }

  /**
   * Asynchronously retrieves cached embeddings from the database based on the provided parameters.
   * @param {Object} opts - The parameters for retrieving cached embeddings.
   * @param {string} opts.query_table_name - The name of the table to retrieve embeddings from.
   * @param {number} opts.query_threshold - The threshold for the levenshtein distance.
   * @param {string} opts.query_input - The input string to search for.
   * @param {string} opts.query_field_name - The name of the field to retrieve embeddings from.
   * @param {string} opts.query_field_sub_name - The name of the sub-field to retrieve embeddings from.
   * @param {number} opts.query_match_count - The maximum number of matches to retrieve.
   * @returns {Promise<{ embedding: number[]; levenshtein_score: number }[]>} A Promise that resolves to an array of cached embeddings.
   */
  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.withDatabase(async () => {
      try {
        const results = await this.db.execute<{
          embedding: number[];
          levenshtein_score: number;
        }>(sql`
                    WITH content_text AS (
                        SELECT
                            m.id,
                            COALESCE(
                                m.content->>${opts.query_field_sub_name},
                                ''
                            ) as content_text
                        FROM memories m
                        WHERE m.type = ${opts.query_table_name}
                            AND m.content->>${opts.query_field_sub_name} IS NOT NULL
                    ),
                    embedded_text AS (
                        SELECT 
                            ct.content_text,
                            COALESCE(
                                e.dim_384,
                                e.dim_512,
                                e.dim_768,
                                e.dim_1024,
                                e.dim_1536,
                                e.dim_3072
                            ) as embedding
                        FROM content_text ct
                        LEFT JOIN embeddings e ON e.memory_id = ct.id
                        WHERE e.memory_id IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(${opts.query_input}, content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(${opts.query_input}, content_text) <= ${opts.query_threshold}
                    ORDER BY levenshtein_score
                    LIMIT ${opts.query_match_count}
                `);

        return results.rows
          .map((row) => ({
            embedding: Array.isArray(row.embedding)
              ? row.embedding
              : typeof row.embedding === 'string'
                ? JSON.parse(row.embedding)
                : [],
            levenshtein_score: Number(row.levenshtein_score),
          }))
          .filter((row) => Array.isArray(row.embedding));
      } catch (error) {
        logger.error('Error in getCachedEmbeddings:', {
          error: error instanceof Error ? error.message : String(error),
          tableName: opts.query_table_name,
          fieldName: opts.query_field_name,
        });
        if (
          error instanceof Error &&
          error.message === 'levenshtein argument exceeds maximum length of 255 characters'
        ) {
          return [];
        }
        throw error;
      }
    });
  }

  /**
   * Asynchronously logs an event in the database.
   * @param {Object} params - The parameters for logging an event.
   * @param {Object} params.body - The body of the event to log.
   * @param {UUID} params.entityId - The ID of the entity associated with the event.
   * @param {UUID} params.roomId - The ID of the room associated with the event.
   * @param {string} params.type - The type of the event to log.
   * @returns {Promise<void>} A Promise that resolves when the event is logged.
   */
  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(logTable).values({
            body: sql`${params.body}::jsonb`,
            entityId: params.entityId,
            roomId: params.roomId,
            type: params.type,
          });
        });
      } catch (error) {
        logger.error('Failed to create log entry:', {
          error: error instanceof Error ? error.message : String(error),
          type: params.type,
          roomId: params.roomId,
          entityId: params.entityId,
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves logs from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving logs.
   * @param {UUID} params.entityId - The ID of the entity associated with the logs.
   * @param {UUID} [params.roomId] - The ID of the room associated with the logs.
   * @param {string} [params.type] - The type of the logs to retrieve.
   * @param {number} [params.count] - The maximum number of logs to retrieve.
   * @param {number} [params.offset] - The offset to retrieve logs from.
   * @returns {Promise<Log[]>} A Promise that resolves to an array of logs.
   */
  async getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    const { entityId, roomId, type, count, offset } = params;
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(logTable)
        .where(
          and(
            eq(logTable.entityId, entityId),
            roomId ? eq(logTable.roomId, roomId) : undefined,
            type ? eq(logTable.type, type) : undefined
          )
        )
        .orderBy(desc(logTable.createdAt))
        .limit(count ?? 10)
        .offset(offset ?? 0);
      return result;
    });
  }

  /**
   * Asynchronously deletes a log from the database based on the provided parameters.
   * @param {UUID} logId - The ID of the log to delete.
   * @returns {Promise<void>} A Promise that resolves when the log is deleted.
   */
  async deleteLog(logId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(eq(logTable.id, logId));
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {Object} params - The parameters for searching for memories.
   * @param {string} params.tableName - The name of the table to search for memories in.
   * @param {UUID} params.roomId - The ID of the room to search for memories in.
   * @param {number[]} params.embedding - The embedding to search for.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemories(params: {
    tableName: string;
    roomId: UUID;
    embedding: number[];
    match_threshold: number;
    count: number;
    unique: boolean;
  }): Promise<Memory[]> {
    return await this.searchMemoriesByEmbedding(params.embedding, {
      match_threshold: params.match_threshold,
      count: params.count,
      roomId: params.roomId,
      unique: params.unique,
      tableName: params.tableName,
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {number[]} embedding - The embedding to search for.
   * @param {Object} params - The parameters for searching for memories.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {UUID} [params.roomId] - The ID of the room to search for memories in.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to search for memories in.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      unique?: boolean;
      tableName: string;
    }
  ): Promise<Memory[]> {
    return this.withDatabase(async () => {
      const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

      const similarity = sql<number>`1 - (${cosineDistance(
        embeddingTable[this.embeddingDimension],
        cleanVector
      )})`;

      const conditions = [eq(memoryTable.type, params.tableName)];

      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      conditions.push(eq(memoryTable.agentId, this.agentId));

      if (params.roomId) {
        conditions.push(eq(memoryTable.roomId, params.roomId));
      }

      if (params.match_threshold) {
        conditions.push(gte(similarity, params.match_threshold));
      }

      const results = await this.db
        .select({
          memory: memoryTable,
          similarity,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(embeddingTable)
        .innerJoin(memoryTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(params.count ?? 10);

      return results.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt,
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata,
        embedding: row.embedding ?? undefined,
        similarity: row.similarity,
      }));
    });
  }

  /**
   * Asynchronously creates a new memory in the database.
   * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
   * @param {string} tableName - The name of the table to create the memory in.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
   */
  async createMemory(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<UUID> {
    logger.debug('DrizzleAdapter createMemory:', {
      memoryId: memory.id,
      embeddingLength: memory.embedding?.length,
      contentLength: memory.content?.text?.length,
    });

    let isUnique = true;
    if (memory.embedding && Array.isArray(memory.embedding)) {
      const similarMemories = await this.searchMemoriesByEmbedding(memory.embedding, {
        tableName,
        roomId: memory.roomId,
        match_threshold: 0.95,
        count: 1,
      });
      isUnique = similarMemories.length === 0;
    }

    const contentToInsert =
      typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content;

    const memoryId = memory.id ?? (v4() as UUID);

    await this.db.transaction(async (tx) => {
      await tx.insert(memoryTable).values([
        {
          id: memoryId,
          type: tableName,
          content: sql`${contentToInsert}::jsonb`,
          metadata: sql`${memory.metadata || {}}::jsonb`,
          entityId: memory.entityId,
          roomId: memory.roomId,
          agentId: memory.agentId,
          unique: memory.unique ?? isUnique,
          createdAt: memory.createdAt,
        },
      ]);

      if (memory.embedding && Array.isArray(memory.embedding)) {
        const embeddingValues: Record<string, unknown> = {
          id: v4(),
          memoryId: memoryId,
          createdAt: memory.createdAt,
        };

        const cleanVector = memory.embedding.map((n) =>
          Number.isFinite(n) ? Number(n.toFixed(6)) : 0
        );

        embeddingValues[this.embeddingDimension] = cleanVector;

        await tx.insert(embeddingTable).values([embeddingValues]);
      }
    });

    return memoryId;
  }

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        logger.debug('Updating memory:', {
          memoryId: memory.id,
          hasEmbedding: !!memory.embedding,
        });

        await this.db.transaction(async (tx) => {
          // Update memory content if provided
          if (memory.content) {
            const contentToUpdate =
              typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content;

            await tx
              .update(memoryTable)
              .set({
                content: sql`${contentToUpdate}::jsonb`,
                ...(memory.metadata && { metadata: sql`${memory.metadata}::jsonb` }),
              })
              .where(eq(memoryTable.id, memory.id));
          } else if (memory.metadata) {
            // Update only metadata if content is not provided
            await tx
              .update(memoryTable)
              .set({
                metadata: sql`${memory.metadata}::jsonb`,
              })
              .where(eq(memoryTable.id, memory.id));
          }

          // Update embedding if provided
          if (memory.embedding && Array.isArray(memory.embedding)) {
            const cleanVector = memory.embedding.map((n) =>
              Number.isFinite(n) ? Number(n.toFixed(6)) : 0
            );

            // Check if embedding exists
            const existingEmbedding = await tx
              .select({ id: embeddingTable.id })
              .from(embeddingTable)
              .where(eq(embeddingTable.memoryId, memory.id))
              .limit(1);

            if (existingEmbedding.length > 0) {
              // Update existing embedding
              const updateValues: Record<string, unknown> = {};
              updateValues[this.embeddingDimension] = cleanVector;

              await tx
                .update(embeddingTable)
                .set(updateValues)
                .where(eq(embeddingTable.memoryId, memory.id));
            } else {
              // Create new embedding
              const embeddingValues: Record<string, unknown> = {
                id: v4(),
                memoryId: memory.id,
                createdAt: Date.now(),
              };
              embeddingValues[this.embeddingDimension] = cleanVector;

              await tx.insert(embeddingTable).values([embeddingValues]);
            }
          }
        });

        logger.debug('Memory updated successfully:', {
          memoryId: memory.id,
        });
        return true;
      } catch (error) {
        logger.error('Error updating memory:', {
          error: error instanceof Error ? error.message : String(error),
          memoryId: memory.id,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // See if there are any fragments that we need to delete
        await this.deleteMemoryFragments(tx, memoryId);

        // Then delete the embedding for the main memory
        await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));

        // Finally delete the memory itself
        await tx.delete(memoryTable).where(eq(memoryTable.id, memoryId));
      });

      logger.debug('Memory and related fragments removed successfully:', {
        memoryId,
      });
    });
  }

  /**
   * Deletes all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be deleted
   * @private
   */
  private async deleteMemoryFragments(tx: DrizzleOperations, documentId: UUID): Promise<void> {
    const fragmentsToDelete = await this.getMemoryFragments(tx, documentId);

    if (fragmentsToDelete.length > 0) {
      const fragmentIds = fragmentsToDelete.map((f) => f.id) as UUID[];

      // Delete embeddings for fragments
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));

      // Delete the fragments
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));

      logger.debug('Deleted related fragments:', {
        documentId,
        fragmentCount: fragmentsToDelete.length,
      });
    }
  }

  /**
   * Retrieves all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be retrieved
   * @returns An array of memory fragments
   * @private
   */
  private async getMemoryFragments(tx: DrizzleOperations, documentId: UUID): Promise<Memory[]> {
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, this.agentId),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
        )
      );

    return fragments;
  }

  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        const memoryIds = await tx
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));

        if (memoryIds.length > 0) {
          await tx.delete(embeddingTable).where(
            inArray(
              embeddingTable.memoryId,
              memoryIds.map((m) => m.id)
            )
          );

          await tx
            .delete(memoryTable)
            .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));
        }
      });

      logger.debug('All memories removed successfully:', {
        roomId,
        tableName,
      });
    });
  }

  /**
   * Asynchronously counts the number of memories in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to count memories in.
   * @param {boolean} [unique] - Whether to count unique memories only.
   * @param {string} [tableName] - The name of the table to count memories in.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  async countMemories(roomId: UUID, unique = true, tableName = ''): Promise<number> {
    if (!tableName) throw new Error('tableName is required');

    return this.withDatabase(async () => {
      const conditions = [eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)];

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(memoryTable)
        .where(and(...conditions));

      return Number(result[0]?.count ?? 0);
    });
  }

  /**
   * Asynchronously retrieves a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve.
   * @returns {Promise<Room | null>} A Promise that resolves to the room if found, null otherwise.
   */
  async getRoom(roomId: UUID): Promise<Room | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: roomTable.id,
          channelId: roomTable.channelId,
          agentId: roomTable.agentId,
          serverId: roomTable.serverId,
          worldId: roomTable.worldId,
          type: roomTable.type,
          source: roomTable.source,
        })
        .from(roomTable)
        .where(and(eq(roomTable.id, roomId), eq(roomTable.agentId, this.agentId)))
        .limit(1);
      if (result.length === 0) return null;
      return result[0];
    });
  }

  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  async getRooms(worldId: UUID): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(roomTable).where(eq(roomTable.worldId, worldId));
      return result;
    });
  }

  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  async updateRoom(room: Room): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(roomTable)
        .set({ ...room, agentId: this.agentId })
        .where(eq(roomTable.id, room.id));
    });
  }

  /**
   * Asynchronously creates a new room in the database based on the provided parameters.
   * @param {Room} room - The room object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created room.
   */
  async createRoom({
    id,
    name,
    source,
    type,
    channelId,
    serverId,
    worldId,
    metadata,
  }: Room): Promise<UUID> {
    return this.withDatabase(async () => {
      const newRoomId = id || v4();
      await this.db
        .insert(roomTable)
        .values({
          id: newRoomId,
          name,
          agentId: this.agentId,
          source,
          type,
          channelId,
          serverId,
          worldId,
          metadata,
        })
        .onConflictDoNothing({ target: roomTable.id });
      return newRoomId as UUID;
    });
  }

  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  async deleteRoom(roomId: UUID): Promise<void> {
    if (!roomId) throw new Error('Room ID is required');
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.id, roomId));
      });
    });
  }

  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.agentId)));

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .selectDistinct({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(
          and(inArray(participantTable.entityId, entityIds), eq(roomTable.agentId, this.agentId))
        );

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .insert(participantTable)
          .values({
            entityId,
            roomId,
            agentId: this.agentId,
          })
          .onConflictDoNothing();
        return true;
      } catch (error) {
        logger.error('Error adding participant', {
          error: error instanceof Error ? error.message : String(error),
          entityId,
          roomId,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.transaction(async (tx) => {
          return await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, entityId), eq(participantTable.roomId, roomId))
            )
            .returning();
        });

        const removed = result.length > 0;
        logger.debug(`Participant ${removed ? 'removed' : 'not found'}:`, {
          entityId,
          roomId,
          removed,
        });

        return removed;
      } catch (error) {
        logger.error('Failed to remove participant:', {
          error: error instanceof Error ? error.message : String(error),
          entityId,
          roomId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously retrieves all participants for an entity from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve participants for.
   * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
   */
  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: participantTable.id,
          entityId: participantTable.entityId,
          roomId: participantTable.roomId,
        })
        .from(participantTable)
        .where(eq(participantTable.entityId, entityId));

      const entity = await this.getEntityById(entityId);

      if (!entity) {
        return [];
      }

      return result.map((row) => ({
        id: row.id as UUID,
        entity: entity,
      }));
    });
  }

  /**
   * Asynchronously retrieves all participants for a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve participants for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
   */
  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    });
  }

  /**
   * Asynchronously retrieves the user state for a participant in a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
   * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
   */
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomState: participantTable.roomState })
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, roomId),
            eq(participantTable.entityId, entityId),
            eq(participantTable.agentId, this.agentId)
          )
        )
        .limit(1);

      return (result[0]?.roomState as 'FOLLOWED' | 'MUTED' | null) ?? null;
    });
  }

  /**
   * Asynchronously sets the user state for a participant in a room in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to set the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to set the user state for.
   * @param {string} state - The state to set the participant's user state to.
   * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
   */
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(participantTable)
            .set({ roomState: state })
            .where(
              and(
                eq(participantTable.roomId, roomId),
                eq(participantTable.entityId, entityId),
                eq(participantTable.agentId, this.agentId)
              )
            );
        });
      } catch (error) {
        logger.error('Failed to set participant user state:', {
          roomId,
          entityId,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously creates a new relationship in the database based on the provided parameters.
   * @param {Object} params - The parameters for creating a new relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @param {string[]} [params.tags] - The tags for the relationship.
   * @param {Object} [params.metadata] - The metadata for the relationship.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the relationship was created successfully.
   */
  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    return this.withDatabase(async () => {
      const id = v4();
      const saveParams = {
        id,
        sourceEntityId: params.sourceEntityId,
        targetEntityId: params.targetEntityId,
        agentId: this.agentId,
        tags: params.tags || [],
        metadata: params.metadata || {},
      };
      try {
        await this.db.insert(relationshipTable).values(saveParams);
        return true;
      } catch (error) {
        logger.error('Error creating relationship:', {
          error: error instanceof Error ? error.message : String(error),
          saveParams,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .update(relationshipTable)
          .set({
            tags: relationship.tags || [],
            metadata: relationship.metadata || {},
          })
          .where(eq(relationshipTable.id, relationship.id));
      } catch (error) {
        logger.error('Error updating relationship:', {
          error: error instanceof Error ? error.message : String(error),
          relationship,
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves a relationship from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving a relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
   */
  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db
          .select()
          .from(relationshipTable)
          .where(
            and(
              eq(relationshipTable.sourceEntityId, params.sourceEntityId),
              eq(relationshipTable.targetEntityId, params.targetEntityId),
              eq(relationshipTable.agentId, this.agentId)
            )
          )
          .limit(1);

        if (result.length === 0) {
          return null;
        }

        return {
          id: result[0].id,
          sourceEntityId: result[0].sourceEntityId,
          targetEntityId: result[0].targetEntityId,
          agentId: result[0].agentId,
          tags: result[0].tags || [],
          metadata: result[0].metadata || {},
          createdAt: result[0].createdAt?.toString(),
        };
      } catch (error) {
        logger.error('Error getting relationship:', {
          error: error instanceof Error ? error.message : String(error),
          params,
        });
        return null;
      }
    });
  }

  /**
   * Asynchronously retrieves all relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID} params.entityId - The ID of the entity to retrieve relationships for.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return this.withDatabase(async () => {
      try {
        let query = this.db
          .select()
          .from(relationshipTable)
          .where(
            and(
              or(
                eq(relationshipTable.sourceEntityId, params.entityId),
                eq(relationshipTable.targetEntityId, params.entityId)
              ),
              eq(relationshipTable.agentId, this.agentId)
            )
          );

        // Filter by tags if provided
        if (params.tags && params.tags.length > 0) {
          // Filter by tags - find tasks that have ALL of the specified tags
          // Using @> operator which checks if left array contains all elements from right array
          const tagParams = params.tags.map((tag) => `'${tag.replace(/'/g, "''")}'`).join(', ');
          query = query.where(
            sql`${relationshipTable.tags} @> ARRAY[${sql.raw(tagParams)}]::text[]`
          );
        }

        const results = await query;

        return results.map((result) => ({
          id: result.id,
          sourceEntityId: result.sourceEntityId,
          targetEntityId: result.targetEntityId,
          agentId: result.agentId,
          tags: result.tags || [],
          metadata: result.metadata || {},
          createdAt: result.createdAt?.toString(),
        }));
      } catch (error) {
        logger.error('Error getting relationships:', {
          error: error instanceof Error ? error.message : String(error),
          params,
        });
        return [];
      }
    });
  }

  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  async getCache<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db
          .select()
          .from(cacheTable)
          .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)));

        return result[0]?.value as T | undefined;
      } catch (error) {
        logger.error('Error fetching cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return undefined;
      }
    });
  }

  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .insert(cacheTable)
            .values({
              key: key,
              agentId: this.agentId,
              value: value,
            })
            .onConflictDoUpdate({
              target: [cacheTable.key, cacheTable.agentId],
              set: {
                value: value,
              },
            });
        });
        return true;
      } catch (error) {
        logger.error('Error setting cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  async deleteCache(key: string): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .delete(cacheTable)
            .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)));
        });
        return true;
      } catch (error) {
        logger.error('Error deleting cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  async createWorld(world: World): Promise<UUID> {
    return this.withDatabase(async () => {
      const newWorldId = world.id || v4();
      await this.db.insert(worldTable).values({
        ...world,
        id: newWorldId,
      });
      return newWorldId;
    });
  }

  /**
   * Asynchronously retrieves a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to retrieve.
   * @returns {Promise<World | null>} A Promise that resolves to the world if found, null otherwise.
   */
  async getWorld(id: UUID): Promise<World | null> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
      return result[0] as World | null;
    });
  }

  /**
   * Asynchronously retrieves all worlds from the database based on the provided parameters.
   * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
   */
  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(eq(worldTable.agentId, this.agentId));
      return result as World[];
    });
  }

  /**
   * Asynchronously updates an existing world in the database based on the provided parameters.
   * @param {World} world - The world object to update.
   * @returns {Promise<void>} A Promise that resolves when the world is updated.
   */
  async updateWorld(world: World): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.update(worldTable).set(world).where(eq(worldTable.id, world.id));
    });
  }

  /**
   * Asynchronously removes a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to remove.
   * @returns {Promise<void>} A Promise that resolves when the world is removed.
   */
  async removeWorld(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(worldTable).where(eq(worldTable.id, id));
    });
  }

  /**
   * Asynchronously creates a new task in the database based on the provided parameters.
   * @param {Task} task - The task object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created task.
   */
  async createTask(task: Task): Promise<UUID> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const now = new Date();
        const metadata = task.metadata || {};

        const values = {
          id: task.id as UUID,
          name: task.name,
          description: task.description,
          roomId: task.roomId,
          worldId: task.worldId,
          tags: task.tags,
          metadata: metadata,
          createdAt: now,
          updatedAt: now,
          agentId: this.agentId,
        };
        const result = await this.db
          .insert(taskTable)
          .values(values)
          .returning({ id: taskTable.id });

        return result[0].id;
      });
    });
  }

  /**
   * Asynchronously retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId and tags to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  async getTasks(params: { roomId?: UUID; tags?: string[] }): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        let query = this.db.select().from(taskTable).where(eq(taskTable.agentId, this.agentId));

        // Apply filters if provided
        if (params.roomId) {
          query = query.where(eq(taskTable.roomId, params.roomId));
        }

        if (params.tags && params.tags.length > 0) {
          // Filter by tags - find tasks that have ALL of the specified tags
          // Using @> operator which checks if left array contains all elements from right array
          const tagParams = params.tags.map((tag) => `'${tag.replace(/'/g, "''")}'`).join(', ');
          query = query.where(sql`${taskTable.tags} @> ARRAY[${sql.raw(tagParams)}]::text[]`);
        }

        const result = await query;

        return result.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          roomId: row.roomId,
          worldId: row.worldId,
          tags: row.tags,
          metadata: row.metadata,
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTasksByName(name: string): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.name, name), eq(taskTable.agentId, this.agentId)));

        return result.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          roomId: row.roomId,
          worldId: row.worldId,
          tags: row.tags || [],
          metadata: row.metadata || {},
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTask(id: UUID): Promise<Task | null> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)))
          .limit(1);

        if (result.length === 0) {
          return null;
        }

        const row = result[0];
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          roomId: row.roomId,
          worldId: row.worldId,
          tags: row.tags || [],
          metadata: row.metadata || {},
        };
      });
    });
  }

  /**
   * Asynchronously updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await this.withRetry(async () => {
      await this.withDatabase(async () => {
        const updateValues: Partial<Task> = {};

        // Add fields to update if they exist in the partial task object
        if (task.name !== undefined) updateValues.name = task.name;
        if (task.description !== undefined) updateValues.description = task.description;
        if (task.roomId !== undefined) updateValues.roomId = task.roomId;
        if (task.worldId !== undefined) updateValues.worldId = task.worldId;
        if (task.tags !== undefined) updateValues.tags = task.tags;

        task.updatedAt = Date.now();

        // Handle metadata updates
        if (task.metadata) {
          // Get current task to merge metadata
          const currentTask = await this.getTask(id);
          if (currentTask) {
            const currentMetadata = currentTask.metadata || {};
            const newMetadata = {
              ...currentMetadata,
              ...task.metadata,
            };
            updateValues.metadata = newMetadata;
          } else {
            updateValues.metadata = {
              ...task.metadata,
            };
          }
        }

        await this.db
          .update(taskTable)
          .set(updateValues)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
      });
    });
  }

  /**
   * Asynchronously deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  async deleteTask(id: UUID): Promise<void> {
    await this.withRetry(async () => {
      await this.withDatabase(async () => {
        await this.db
          .delete(taskTable)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
      });
    });
  }

  /**
   * Asynchronously retrieves group chat memories from all rooms under a given server.
   * It fetches all room IDs associated with the `serverId`, then retrieves memories
   * from those rooms in descending order (latest to oldest), with an optional count limit.
   *
   * @param {Object} params - Parameters for fetching memories.
   * @param {UUID} params.serverId - The server ID to fetch memories for.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} - A promise that resolves to an array of memory objects.
   */
  async getMemoriesByServerId(params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      // Step 1: Fetch all room IDs associated with the given serverId
      const roomIdsResult = await this.db
        .select({ roomId: roomTable.id })
        .from(roomTable)
        .where(eq(roomTable.serverId, params.serverId));

      if (roomIdsResult.length === 0) return [];

      const roomIds = roomIdsResult.map((row) => row.roomId);

      // Step 2: Fetch all memories for these rooms, ordered from latest to oldest
      const query = this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(inArray(memoryTable.roomId, roomIds))
        .orderBy(desc(memoryTable.createdAt));

      // Step 3: Apply the count limit if provided
      const rows = params.count ? await query.limit(params.count) : await query;

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt,
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        embedding: row.embedding ?? undefined,
      }));
    });
  }

  /**
   * Asynchronously deletes all rooms associated with a specific serverId.
   * @param {UUID} serverId - The server ID to delete rooms for.
   * @returns {Promise<void>} A Promise that resolves when the rooms are deleted.
   */
  async deleteRoomsByServerId(serverId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.serverId, serverId));
      });

      logger.debug('Rooms deleted successfully for server:', {
        serverId,
      });
    });
  }
}
