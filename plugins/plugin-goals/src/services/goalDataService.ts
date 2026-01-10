import { type IAgentRuntime, type UUID, logger, Service, ServiceType, asUUID } from '@elizaos/core';
import { and, eq, isNull, asc, inArray, type SQL } from 'drizzle-orm';
import { goalsTable, goalTagsTable } from '../schema.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Goal data structure from database
 */
export interface GoalData {
  id: UUID;
  agentId: UUID;
  ownerType: 'agent' | 'entity';
  ownerId: UUID;
  name: string;
  description?: string | null;
  isCompleted: boolean;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
  tags?: string[];
}

/**
 * Service for managing goal data
 */
export class GoalDataService {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Create a new goal
   */
  async createGoal(params: {
    agentId: UUID;
    ownerType: 'agent' | 'entity';
    ownerId: UUID;
    name: string;
    description?: string;
    metadata?: Record<string, any>;
    tags?: string[];
  }): Promise<UUID | null> {
    try {
      const db = this.runtime.db;
      if (!db) throw new Error('Database not available');

      // Create the goal
      const goalId = asUUID(uuidv4());
      const values: any = {
        id: goalId,
        agentId: params.agentId,
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        name: params.name,
        metadata: params.metadata || {},
      };
      
      // Only include description if it's provided
      if (params.description !== undefined) {
        values.description = params.description;
      }
      
      const [goal] = await db
        .insert(goalsTable)
        .values(values)
        .returning();

      if (!goal) return null;

      // Add tags if provided
      if (params.tags && params.tags.length > 0) {
        const tagInserts = params.tags.map((tag) => ({
          id: asUUID(uuidv4()),
          goalId: goal.id,
          tag,
        }));

        await db.insert(goalTagsTable).values(tagInserts);
      }

      return goal.id;
    } catch (error) {
      logger.error('Error creating goal:', error);
      throw error;
    }
  }

  /**
   * Get goals with optional filters
   */
  async getGoals(filters?: {
    ownerType?: 'agent' | 'entity';
    ownerId?: UUID;
    isCompleted?: boolean;
    tags?: string[];
  }): Promise<GoalData[]> {
    try {
      const db = this.runtime.db;
      if (!db) throw new Error('Database not available');

      const conditions: SQL[] = [];
      if (filters?.ownerType) {
        conditions.push(eq(goalsTable.ownerType, filters.ownerType));
      }
      if (filters?.ownerId) {
        conditions.push(eq(goalsTable.ownerId, filters.ownerId));
      }
      if (filters?.isCompleted !== undefined) {
        conditions.push(eq(goalsTable.isCompleted, filters.isCompleted));
      }

      const goals = await db
        .select()
        .from(goalsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(goalsTable.createdAt));

      // Get tags for all goals
      const goalIds = goals.map((goal) => goal.id);
      if (goalIds.length === 0) return [];

      const tags = await db
        .select()
        .from(goalTagsTable)
        .where(
          goalIds.length === 1
            ? eq(goalTagsTable.goalId, goalIds[0])
            : inArray(goalTagsTable.goalId, goalIds)
        );

      // Group tags by goal
      const tagsByGoal = tags.reduce(
        (acc, tag) => {
          if (!acc[tag.goalId]) acc[tag.goalId] = [];
          acc[tag.goalId].push(tag.tag);
          return acc;
        },
        {} as Record<string, string[]>
      );

      // Filter by tags if specified
      let filteredGoals = goals;
      if (filters?.tags && filters.tags.length > 0) {
        filteredGoals = goals.filter((goal) => {
          const goalTags = tagsByGoal[goal.id] || [];
          return filters.tags!.some((tag) => goalTags.includes(tag));
        });
      }

      return filteredGoals.map((goal) => ({
        ...goal,
        tags: tagsByGoal[goal.id] || [],
        createdAt: new Date(goal.createdAt),
        updatedAt: new Date(goal.updatedAt),
        completedAt: goal.completedAt ? new Date(goal.completedAt) : null,
      }));
    } catch (error) {
      logger.error('Error getting goals:', error);
      throw error;
    }
  }

  /**
   * Get a single goal by ID
   */
  async getGoal(goalId: UUID): Promise<GoalData | null> {
    try {
      const db = this.runtime.db;
      if (!db) throw new Error('Database not available');

      const [goal] = await db.select().from(goalsTable).where(eq(goalsTable.id, goalId));

      if (!goal) return null;

      // Get tags
      const tags = await db.select().from(goalTagsTable).where(eq(goalTagsTable.goalId, goalId));

      return {
        ...goal,
        tags: tags.map((t) => t.tag),
        createdAt: new Date(goal.createdAt),
        updatedAt: new Date(goal.updatedAt),
        completedAt: goal.completedAt ? new Date(goal.completedAt) : null,
      };
    } catch (error) {
      logger.error('Error getting goal:', error);
      throw error;
    }
  }

  /**
   * Update a goal
   */
  async updateGoal(
    goalId: UUID,
    updates: {
      name?: string;
      description?: string;
      isCompleted?: boolean;
      completedAt?: Date;
      metadata?: Record<string, any>;
      tags?: string[];
    }
  ): Promise<boolean> {
    try {
      const db = this.runtime.db;
      if (!db) throw new Error('Database not available');

      // Update goal fields
      const fieldsToUpdate: any = {
        updatedAt: new Date(),
      };

      if (updates.name !== undefined) fieldsToUpdate.name = updates.name;
      if (updates.description !== undefined) fieldsToUpdate.description = updates.description;
      if (updates.isCompleted !== undefined) fieldsToUpdate.isCompleted = updates.isCompleted;
      if (updates.completedAt !== undefined) fieldsToUpdate.completedAt = updates.completedAt;
      if (updates.metadata !== undefined) fieldsToUpdate.metadata = updates.metadata;

      await db.update(goalsTable).set(fieldsToUpdate).where(eq(goalsTable.id, goalId));

      // Update tags if provided
      if (updates.tags !== undefined) {
        // Delete existing tags
        await db.delete(goalTagsTable).where(eq(goalTagsTable.goalId, goalId));

        // Insert new tags
        if (updates.tags.length > 0) {
          const tagInserts = updates.tags.map((tag) => ({
            id: asUUID(uuidv4()),
            goalId,
            tag,
          }));

          await db.insert(goalTagsTable).values(tagInserts);
        }
      }

      return true;
    } catch (error) {
      logger.error('Error updating goal:', error);
      throw error;
    }
  }

  /**
   * Delete a goal
   */
  async deleteGoal(goalId: UUID): Promise<boolean> {
    try {
      const db = this.runtime.db;
      if (!db) throw new Error('Database not available');

      await db.delete(goalsTable).where(eq(goalsTable.id, goalId));
      return true;
    } catch (error) {
      logger.error('Error deleting goal:', error);
      throw error;
    }
  }

  /**
   * Get uncompleted goals
   */
  async getUncompletedGoals(ownerType?: 'agent' | 'entity', ownerId?: UUID): Promise<GoalData[]> {
    try {
      const conditions = [eq(goalsTable.isCompleted, false)];

      if (ownerType) {
        conditions.push(eq(goalsTable.ownerType, ownerType));
      }
      if (ownerId) {
        conditions.push(eq(goalsTable.ownerId, ownerId));
      }

      return this.getGoals({
        isCompleted: false,
        ownerType,
        ownerId,
      });
    } catch (error) {
      logger.error('Error getting uncompleted goals:', error);
      throw error;
    }
  }

  /**
   * Get completed goals
   */
  async getCompletedGoals(ownerType?: 'agent' | 'entity', ownerId?: UUID): Promise<GoalData[]> {
    try {
      return this.getGoals({
        isCompleted: true,
        ownerType,
        ownerId,
      });
    } catch (error) {
      logger.error('Error getting completed goals:', error);
      throw error;
    }
  }

  /**
   * Count goals with filters
   */
  async countGoals(
    ownerType: 'agent' | 'entity',
    ownerId: UUID,
    isCompleted?: boolean
  ): Promise<number> {
    try {
      const goals = await this.getGoals({
        ownerType,
        ownerId,
        isCompleted,
      });
      return goals.length;
    } catch (error) {
      logger.error('Error counting goals:', error);
      throw error;
    }
  }

  /**
   * Get all goals for a specific owner (both completed and uncompleted)
   */
  async getAllGoalsForOwner(ownerType: 'agent' | 'entity', ownerId: UUID): Promise<GoalData[]> {
    try {
      return this.getGoals({
        ownerType,
        ownerId,
      });
    } catch (error) {
      logger.error('Error getting all goals for owner:', error);
      throw error;
    }
  }
}

/**
 * Factory function to create a GoalDataService
 */
export function createGoalDataService(runtime: IAgentRuntime): GoalDataService {
  if (!runtime.db) {
    throw new Error('Database instance not available on runtime');
  }
  return new GoalDataService(runtime);
}

/**
 * Service wrapper for the GoalDataService to be registered with the plugin
 */
export class GoalDataServiceWrapper extends Service {
  static serviceName = 'goalDataService';
  static serviceType = 'GOAL_DATA' as any; // Custom service type for goal data

  private goalDataService: GoalDataService | null = null;

  capabilityDescription = 'Manages goal data storage and retrieval';

  async stop(): Promise<void> {
    // Clean up any resources if needed
    this.goalDataService = null;
  }

  static async start(runtime: IAgentRuntime): Promise<GoalDataServiceWrapper> {
    const service = new GoalDataServiceWrapper();

    if (!runtime.db) {
      logger.warn('Database not available, GoalDataService will be limited');
    } else {
      service.goalDataService = new GoalDataService(runtime);
    }

    return service;
  }

  /**
   * Get the underlying GoalDataService instance
   */
  getDataService(): GoalDataService | null {
    return this.goalDataService;
  }
}
