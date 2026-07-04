/**
 * CRUD store for the `agents` table: maps between the DB row shape (Drizzle
 * insert/select types, epoch-millis timestamps, DB-encoded knowledge/message
 * examples) and the runtime's `Agent` domain type. `update` deep-merges
 * `settings` with the existing row rather than overwriting it wholesale.
 */
import { type Agent, ElizaError, logger, type UUID } from "@elizaos/core";
import { count, eq } from "drizzle-orm";
import {
  documentsFromDb,
  documentsToDb,
  messageExamplesFromDb,
  messageExamplesToDb,
} from "../agent-mapping";
import { agentTable } from "../schema/index";
import type { DrizzleDatabase } from "../types";
import type { Store, StoreContext } from "./types";

function normalizeAgentBio(bio: string | string[] | null | undefined): string[] {
  if (Array.isArray(bio)) return bio;
  if (typeof bio === "string" && bio.length > 0) return [bio];
  return [];
}

function toEpochMillis(value: number | bigint | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return value ?? Date.now();
}

export class AgentStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get(agentId: UUID): Promise<Agent | null> {
    return this.ctx.withRetry(async () => {
      const rows = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];
      const agent = {
        ...row,
        username: row.username || "",
        id: row.id as UUID,
        system: !row.system ? undefined : row.system,
        bio: normalizeAgentBio(row.bio),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        messageExamples: messageExamplesFromDb(row.messageExamples),
        knowledge: documentsFromDb(row.knowledge),
      } as Agent;
      return agent;
    }, "AgentStore.get");
  }

  async getAll(): Promise<Partial<Agent>[]> {
    const result = await this.ctx.withRetry(async () => {
      const rows = await this.db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          bio: agentTable.bio,
        })
        .from(agentTable);
      return rows.map((row) => ({
        ...row,
        id: row.id as UUID,
        bio: normalizeAgentBio(row.bio),
      }));
    }, "AgentStore.getAll");
    return result;
  }

  async create(agent: Agent): Promise<boolean> {
    if (!agent.name) {
      throw new ElizaError("Cannot create agent without a name", {
        code: "DB_INVALID_ARGUMENT",
        context: { table: "agents", agentId: agent.id },
      });
    }
    return this.ctx.withRetry(async () => {
      try {
        if (agent.id) {
          const existing = await this.db
            .select({ id: agentTable.id })
            .from(agentTable)
            .where(eq(agentTable.id, agent.id))
            .limit(1);

          if (existing.length > 0) {
            logger.warn(
              { src: "plugin:sql", agentId: agent.id },
              "Attempted to create agent with duplicate ID"
            );
            return false;
          }
        }

        const values: typeof agentTable.$inferInsert = {
          ...agent,
          name: agent.name,
          knowledge: documentsToDb(agent.knowledge),
          messageExamples: messageExamplesToDb(agent.messageExamples),
          createdAt: new Date(toEpochMillis(agent.createdAt)),
          updatedAt: new Date(toEpochMillis(agent.updatedAt)),
        };
        await this.db.transaction(async (tx) => {
          await tx.insert(agentTable).values(values);
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — false is the typed "duplicate
        // id" outcome above; a write failure must not collapse into it.
        throw new ElizaError("AgentStore.create failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "agents", agentId: agent.id },
        });
      }
    }, "AgentStore.create");
  }

  async update(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    if (!agentId) {
      throw new ElizaError("Agent ID is required for update", {
        code: "DB_INVALID_ARGUMENT",
        context: { table: "agents" },
      });
    }
    return this.ctx.withRetry(async () => {
      try {
        await this.db.transaction(async (tx) => {
          if (agent.settings) {
            agent.settings = await this.mergeSettings(tx, agentId, agent.settings);
          }

          const updateData: Record<string, unknown> = { ...agent };

          if (updateData.createdAt) {
            if (
              typeof updateData.createdAt === "number" ||
              typeof updateData.createdAt === "bigint"
            ) {
              const createdAtValue =
                typeof updateData.createdAt === "bigint"
                  ? Number(updateData.createdAt)
                  : updateData.createdAt;
              updateData.createdAt = new Date(createdAtValue);
            } else {
              delete updateData.createdAt;
            }
          }
          if (updateData.updatedAt) {
            if (
              typeof updateData.updatedAt === "number" ||
              typeof updateData.updatedAt === "bigint"
            ) {
              const updatedAtValue =
                typeof updateData.updatedAt === "bigint"
                  ? Number(updateData.updatedAt)
                  : updateData.updatedAt;
              updateData.updatedAt = new Date(updatedAtValue);
            } else {
              updateData.updatedAt = new Date();
            }
          } else {
            updateData.updatedAt = new Date();
          }

          await tx.update(agentTable).set(updateData).where(eq(agentTable.id, agentId));
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed update must not read
        // as a benign false.
        throw new ElizaError("AgentStore.update failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    }, "AgentStore.update");
  }

  async delete(agentId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        const result = await this.db
          .delete(agentTable)
          .where(eq(agentTable.id, agentId))
          .returning();

        // false is the typed "no agent matched" outcome, distinct from failure.
        if (result.length === 0) {
          logger.warn({ src: "plugin:sql", agentId }, "Agent not found for deletion");
          return false;
        }

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — surface a real delete failure
        // (the not-found case already returned false above).
        throw new ElizaError("AgentStore.delete failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    }, "AgentStore.delete");
  }

  async count(): Promise<number> {
    return this.ctx.withRetry(async () => {
      // No catch: "DB broken" must never read as "0 agents". The aggregate
      // always returns one row, so a missing count is a broken pipeline.
      const result = await this.db.select({ count: count() }).from(agentTable);
      const total = result[0]?.count;
      if (typeof total !== "number") {
        throw new ElizaError("AgentStore.count returned no count row", {
          code: "DB_COUNT_FAILED",
          context: { table: "agents" },
        });
      }
      return total;
    }, "AgentStore.count");
  }

  async deleteAll(): Promise<void> {
    // No catch: a delete failure propagates via withRetry; the previous
    // log-then-rethrow added no context the retry layer doesn't log.
    return this.ctx.withRetry(async () => {
      await this.db.delete(agentTable);
    }, "AgentStore.deleteAll");
  }

  private async mergeSettings<T extends Record<string, unknown>>(
    tx: DrizzleDatabase,
    agentId: UUID,
    updatedSettings: T
  ): Promise<T> {
    const currentAgent = await tx
      .select({ settings: agentTable.settings })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    const currentSettings =
      currentAgent.length > 0 && currentAgent[0].settings ? currentAgent[0].settings : {};

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    const deepMerge = (
      target: unknown,
      source: Record<string, unknown>
    ): Record<string, unknown> | undefined => {
      const output: Record<string, unknown> = isRecord(target) ? { ...target } : {};

      for (const key of Object.keys(source)) {
        const sourceValue = source[key];
        if (sourceValue === null) {
          delete output[key];
        } else if (isRecord(sourceValue)) {
          const nested = deepMerge(output[key], sourceValue);
          if (nested === undefined) delete output[key];
          else output[key] = nested;
        } else {
          output[key] = sourceValue;
        }
      }

      if (Object.keys(output).length === 0) {
        if (!(typeof source === "object" && source !== null && Object.keys(source).length === 0)) {
          return undefined;
        }
      }
      return output;
    };

    const finalSettings = deepMerge(currentSettings, updatedSettings);
    return (finalSettings ?? {}) as T;
  }
}
