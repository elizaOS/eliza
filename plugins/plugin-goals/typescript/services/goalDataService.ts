import { asUUID, type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { goalsTable, goalTagsTable } from "../schema.js";

type DrizzleTable = unknown;
type DrizzleCondition = unknown;
type DrizzleValues = Record<string, unknown>;
type DrizzleFields = Record<string, unknown>;
type DrizzleResult = Record<string, unknown>;
type OrderByArg = unknown;

type DrizzleDB = {
  insert: (table: DrizzleTable) => {
    values: (values: DrizzleValues | DrizzleValues[]) => {
      returning: () => Promise<DrizzleResult[]>;
      onConflictDoNothing: () => { execute: () => Promise<void> };
    };
  };
  select: (fields?: DrizzleFields) => {
    from: (table: DrizzleTable) => {
      where: (
        condition?: DrizzleCondition
      ) => { orderBy: (...args: OrderByArg[]) => Promise<DrizzleResult[]> } & Promise<
        DrizzleResult[]
      >;
    };
  };
  update: (table: DrizzleTable) => {
    set: (values: DrizzleValues) => {
      where: (condition: DrizzleCondition) => Promise<DrizzleResult>;
    };
  };
  delete: (table: DrizzleTable) => {
    where: (condition: DrizzleCondition) => Promise<DrizzleResult>;
  };
};

/**
 * Goal data structure from database
 */
export interface GoalData {
  id: UUID;
  agentId: UUID;
  ownerType: "agent" | "entity";
  ownerId: UUID;
  name: string;
  description?: string | null;
  isCompleted: boolean;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  tags?: string[];
}

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
    ownerType: "agent" | "entity";
    ownerId: UUID;
    name: string;
    description?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Promise<UUID | null> {
    try {
      const db = this.runtime.db as DrizzleDB | undefined;
      if (!db) throw new Error("Database not available");

      const goalId = asUUID(uuidv4());
      const values: DrizzleValues = {
        id: goalId,
        agentId: params.agentId,
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        name: params.name,
        metadata: params.metadata || {},
      };

      if (params.description !== undefined) {
        values.description = params.description;
      }

      const [goal] = await db.insert(goalsTable).values(values).returning();

      if (!goal) return null;

      if (params.tags && params.tags.length > 0) {
        const tagInserts = params.tags.map((tag) => ({
          id: asUUID(uuidv4()),
          goalId,
          tag,
        }));

        await db.insert(goalTagsTable).values(tagInserts);
      }

      return goalId;
    } catch (error) {
      logger.error("Error creating goal:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getGoals(filters?: {
    ownerType?: "agent" | "entity";
    ownerId?: UUID;
    isCompleted?: boolean;
    tags?: string[];
  }): Promise<GoalData[]> {
    try {
      const db = this.runtime.db as DrizzleDB | undefined;
      if (!db) throw new Error("Database not available");

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
      const goalIds = goals.map((goal) => asUUID(goal.id as string));
      if (goalIds.length === 0) return [];

      const tags = await db
        .select()
        .from(goalTagsTable)
        .where(
          goalIds.length === 1
            ? eq(goalTagsTable.goalId, goalIds[0])
            : inArray(goalTagsTable.goalId, goalIds)
        );

      const tagsByGoal = tags.reduce(
        (acc, tag) => {
          const tagGoalId = asUUID(tag.goalId as string);
          if (!acc[tagGoalId]) acc[tagGoalId] = [];
          const goalTags = acc[tagGoalId] as string[];
          goalTags.push(tag.tag as string);
          return acc;
        },
        {} as Record<UUID, string[]>
      );

      // Filter by tags if specified
      let filteredGoals = goals;
      if (filters?.tags && filters.tags.length > 0) {
        filteredGoals = goals.filter((goal) => {
          const goalId = asUUID(goal.id as string);
          const goalTags = (tagsByGoal[goalId] || []) as string[];
          return filters.tags?.some((tag) => goalTags.includes(tag));
        });
      }

      return filteredGoals.map((goal) => {
        const goalId = asUUID(goal.id as string);
        return {
          ...goal,
          id: goalId,
          agentId: asUUID(goal.agentId as string),
          ownerId: asUUID(goal.ownerId as string),
          tags: tagsByGoal[goalId] || [],
          createdAt: new Date(goal.createdAt as string | number | Date),
          updatedAt: new Date(goal.updatedAt as string | number | Date),
          completedAt: goal.completedAt
            ? new Date(goal.completedAt as string | number | Date)
            : null,
        } as GoalData;
      });
    } catch (error) {
      logger.error("Error getting goals:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getGoal(goalId: UUID): Promise<GoalData | null> {
    try {
      const db = this.runtime.db as DrizzleDB | undefined;
      if (!db) throw new Error("Database not available");

      const [goal] = await db.select().from(goalsTable).where(eq(goalsTable.id, goalId));

      if (!goal) return null;

      const tags = await db.select().from(goalTagsTable).where(eq(goalTagsTable.goalId, goalId));

      return {
        ...goal,
        id: asUUID(goal.id as string),
        agentId: asUUID(goal.agentId as string),
        ownerId: asUUID(goal.ownerId as string),
        tags: tags.map((t) => t.tag as string),
        createdAt: new Date(goal.createdAt as string | number | Date),
        updatedAt: new Date(goal.updatedAt as string | number | Date),
        completedAt: goal.completedAt ? new Date(goal.completedAt as string | number | Date) : null,
      } as GoalData;
    } catch (error) {
      logger.error("Error getting goal:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async updateGoal(
    goalId: UUID,
    updates: {
      name?: string;
      description?: string;
      isCompleted?: boolean;
      completedAt?: Date;
      metadata?: Record<string, unknown>;
      tags?: string[];
    }
  ): Promise<boolean> {
    try {
      const db = this.runtime.db as DrizzleDB | undefined;
      if (!db) throw new Error("Database not available");

      const fieldsToUpdate: DrizzleValues = {
        updatedAt: new Date(),
      };

      if (updates.name !== undefined) fieldsToUpdate.name = updates.name;
      if (updates.description !== undefined) fieldsToUpdate.description = updates.description;
      if (updates.isCompleted !== undefined) fieldsToUpdate.isCompleted = updates.isCompleted;
      if (updates.completedAt !== undefined) fieldsToUpdate.completedAt = updates.completedAt;
      if (updates.metadata !== undefined) fieldsToUpdate.metadata = updates.metadata;

      await db.update(goalsTable).set(fieldsToUpdate).where(eq(goalsTable.id, goalId));

      if (updates.tags !== undefined) {
        await db.delete(goalTagsTable).where(eq(goalTagsTable.goalId, goalId));

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
      logger.error("Error updating goal:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async deleteGoal(goalId: UUID): Promise<boolean> {
    try {
      const db = this.runtime.db as DrizzleDB | undefined;
      if (!db) throw new Error("Database not available");

      await db.delete(goalsTable).where(eq(goalsTable.id, goalId));
      return true;
    } catch (error) {
      logger.error("Error deleting goal:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getUncompletedGoals(ownerType?: "agent" | "entity", ownerId?: UUID): Promise<GoalData[]> {
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
      logger.error(
        "Error getting uncompleted goals:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async getCompletedGoals(ownerType?: "agent" | "entity", ownerId?: UUID): Promise<GoalData[]> {
    try {
      return this.getGoals({
        isCompleted: true,
        ownerType,
        ownerId,
      });
    } catch (error) {
      logger.error(
        "Error getting completed goals:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async countGoals(
    ownerType: "agent" | "entity",
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
      logger.error("Error counting goals:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getAllGoalsForOwner(ownerType: "agent" | "entity", ownerId: UUID): Promise<GoalData[]> {
    try {
      return this.getGoals({
        ownerType,
        ownerId,
      });
    } catch (error) {
      logger.error(
        "Error getting all goals for owner:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }
}

/**
 * Factory function to create a GoalDataService
 */
export function createGoalDataService(runtime: IAgentRuntime): GoalDataService {
  if (!runtime.db) {
    throw new Error("Database instance not available on runtime");
  }
  return new GoalDataService(runtime);
}

export class GoalDataServiceWrapper extends Service {
  static serviceName = "goalDataService";
  static serviceType = "GOAL_DATA" as const;

  private goalDataService: GoalDataService | null = null;

  capabilityDescription = "Manages goal data storage and retrieval";

  async stop(): Promise<void> {
    this.goalDataService = null;
  }

  static async start(runtime: IAgentRuntime): Promise<GoalDataServiceWrapper> {
    const service = new GoalDataServiceWrapper();

    if (!runtime.db) {
      logger.warn("Database not available, GoalDataService will be limited");
    } else {
      service.goalDataService = new GoalDataService(runtime);
    }

    return service;
  }

  getDataService(): GoalDataService | null {
    return this.goalDataService;
  }
}
