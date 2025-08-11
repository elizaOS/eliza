import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { memories } from "@/lib/db/schema";

export class Database {
  private static instance: NodePgDatabase;

  private constructor() {
    // Private constructor to prevent direct instantiation
  }

  public static getInstance(): NodePgDatabase {
    if (!Database.instance) {
      Database.instance = drizzle(process.env.POSTGRES_URL ?? "");
    }
    return Database.instance;
  }

  /**
   * Sets a memory for an agent. Creates a new memory if id is not provided,
   * or updates an existing memory if id is provided.
   * @param agentId - The ID of the agent
   * @param content - The memory content
   * @param id - Optional memory ID for updates
   * @returns The created or updated memory
   */
  public static async setMemory(agentId: number, content: string, id?: number) {
    const db = Database.getInstance();

    if (id) {
      // Update existing memory
      const [updated] = await db
        .update(memories)
        .set({
          content,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, id))
        .returning();

      return updated;
    } else {
      // Insert new memory
      const [inserted] = await db
        .insert(memories)
        .values({
          agentId,
          content,
        })
        .returning();

      return inserted;
    }
  }
}
