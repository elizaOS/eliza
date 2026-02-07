import { eq, desc, and, sql, count, sum } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  generations,
  type Generation,
  type NewGeneration,
} from "../schemas/generations";

export type { Generation, NewGeneration };

/**
 * Repository for generation (image/video) database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class GenerationsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Finds a generation by ID.
   */
  async findById(id: string): Promise<Generation | undefined> {
    return await dbRead.query.generations.findFirst({
      where: eq(generations.id, id),
    });
  }

  /**
   * Finds a generation by job ID.
   */
  async findByJobId(jobId: string): Promise<Generation | undefined> {
    return await dbRead.query.generations.findFirst({
      where: eq(generations.job_id, jobId),
    });
  }

  /**
   * Lists generations for an organization, ordered by creation date.
   */
  async listByOrganization(
    organizationId: string,
    limit?: number,
  ): Promise<Generation[]> {
    return await dbRead.query.generations.findMany({
      where: eq(generations.organization_id, organizationId),
      orderBy: desc(generations.created_at),
      limit,
    });
  }

  /**
   * Lists generations for an organization filtered by type.
   */
  async listByOrganizationAndType(
    organizationId: string,
    type: string,
    limit?: number,
  ): Promise<Generation[]> {
    return await dbRead.query.generations.findMany({
      where: and(
        eq(generations.organization_id, organizationId),
        eq(generations.type, type),
      ),
      orderBy: desc(generations.created_at),
      limit,
    });
  }

  /**
   * Lists generations for an organization filtered by status with optional filters.
   */
  async listByOrganizationAndStatus(
    organizationId: string,
    status: string,
    options?: {
      userId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Generation[]> {
    const conditions = [
      eq(generations.organization_id, organizationId),
      eq(generations.status, status),
    ];

    if (options?.userId) {
      conditions.push(eq(generations.user_id, options.userId));
    }

    if (options?.type) {
      conditions.push(eq(generations.type, options.type));
    }

    return await dbRead.query.generations.findMany({
      where: and(...conditions),
      orderBy: desc(generations.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  /**
   * Lists random completed images from all users (for explore/discover).
   */
  async listRandomPublicImages(limit: number = 20): Promise<Generation[]> {
    return await dbRead.query.generations.findMany({
      where: and(
        eq(generations.status, "completed"),
        eq(generations.type, "image"),
        sql`${generations.storage_url} IS NOT NULL`,
      ),
      orderBy: sql`RANDOM()`,
      limit,
    });
  }

  /**
   * Gets generation statistics for an organization within an optional date range.
   */
  async getStats(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    totalGenerations: number;
    completedGenerations: number;
    failedGenerations: number;
    pendingGenerations: number;
    totalCredits: number;
    byType: Array<{
      type: string;
      count: number;
      totalCredits: number;
    }>;
  }> {
    const conditions = [eq(generations.organization_id, organizationId)];

    if (startDate) {
      conditions.push(sql`${generations.created_at} >= ${startDate}`);
    }

    if (endDate) {
      conditions.push(sql`${generations.created_at} <= ${endDate}`);
    }

    const [totalResult] = await dbRead
      .select({
        total: count(),
        completed: sql<number>`count(*) filter (where ${generations.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${generations.status} = 'failed')::int`,
        pending: sql<number>`count(*) filter (where ${generations.status} = 'pending')::int`,
        totalCredits: sum(generations.credits),
      })
      .from(generations)
      .where(and(...conditions));

    const byTypeResult = await dbRead
      .select({
        type: generations.type,
        count: sql<number>`count(*)::int`,
        totalCredits: sql<number>`sum(${generations.credits})::numeric`,
      })
      .from(generations)
      .where(and(...conditions))
      .groupBy(generations.type);

    return {
      totalGenerations: Number(totalResult?.total || 0),
      completedGenerations: Number(totalResult?.completed || 0),
      failedGenerations: Number(totalResult?.failed || 0),
      pendingGenerations: Number(totalResult?.pending || 0),
      totalCredits: Number(totalResult?.totalCredits || 0),
      byType: byTypeResult.map((r) => ({
        type: r.type,
        count: Number(r.count),
        totalCredits: Number(r.totalCredits || 0),
      })),
    };
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Creates a new generation record.
   */
  async create(data: NewGeneration): Promise<Generation> {
    const [generation] = await dbWrite
      .insert(generations)
      .values(data)
      .returning();
    return generation;
  }

  /**
   * Updates an existing generation.
   */
  async update(
    id: string,
    data: Partial<NewGeneration>,
  ): Promise<Generation | undefined> {
    const [updated] = await dbWrite
      .update(generations)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(generations.id, id))
      .returning();
    return updated;
  }

  /**
   * Deletes a generation by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(generations).where(eq(generations.id, id));
  }
}

/**
 * Singleton instance of GenerationsRepository.
 */
export const generationsRepository = new GenerationsRepository();
