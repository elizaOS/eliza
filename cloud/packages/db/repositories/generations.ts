import { randomUUID } from "node:crypto";
import { and, count, desc, eq, sql, sum } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import {
  hydrateJsonField,
  hydrateTextField,
  offloadJsonField,
  offloadTextField,
} from "@/lib/storage/object-store";
import { dbRead, dbWrite } from "../helpers";
import { type Generation, generations, type NewGeneration } from "../schemas/generations";

export type { Generation, NewGeneration };

export type GenerationSummary = Omit<
  Generation,
  | "prompt"
  | "negative_prompt"
  | "result"
  | "content"
  | "prompt_storage"
  | "prompt_key"
  | "negative_prompt_storage"
  | "negative_prompt_key"
  | "result_storage"
  | "result_key"
  | "content_storage"
  | "content_key"
> & {
  prompt_preview: string;
  negative_prompt_preview: string | null;
  content_preview: string | null;
  has_result_payload: boolean;
};

function hasPayloadUpdates(data: Partial<NewGeneration>): boolean {
  return (
    data.prompt !== undefined ||
    data.negative_prompt !== undefined ||
    data.result !== undefined ||
    data.content !== undefined
  );
}

async function hydrateGeneration(generation: Generation): Promise<Generation> {
  const [prompt, negativePrompt, result, content] = await Promise.all([
    hydrateTextField({
      storage: generation.prompt_storage,
      key: generation.prompt_key,
      inlineValue: generation.prompt,
    }),
    hydrateTextField({
      storage: generation.negative_prompt_storage,
      key: generation.negative_prompt_key,
      inlineValue: generation.negative_prompt,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: generation.result_storage,
      key: generation.result_key,
      inlineValue: generation.result ?? null,
    }),
    hydrateTextField({
      storage: generation.content_storage,
      key: generation.content_key,
      inlineValue: generation.content,
    }),
  ]);

  return {
    ...generation,
    prompt: prompt ?? "",
    negative_prompt: negativePrompt,
    result,
    content,
  };
}

function toGenerationSummary(generation: Generation): GenerationSummary {
  const {
    prompt,
    negative_prompt,
    result,
    content,
    prompt_storage,
    prompt_key,
    negative_prompt_storage,
    negative_prompt_key,
    result_storage,
    result_key,
    content_storage,
    content_key,
    ...summary
  } = generation;

  return {
    ...summary,
    prompt_preview: prompt,
    negative_prompt_preview: negative_prompt,
    content_preview: content,
    has_result_payload: result_storage === "r2" ? Boolean(result_key) : result != null,
  };
}

async function prepareGenerationPayload(
  data: NewGeneration | Partial<NewGeneration>,
  context: Pick<Generation, "id" | "organization_id" | "created_at">,
): Promise<NewGeneration | Partial<NewGeneration>> {
  if (
    data.prompt_storage === "r2" ||
    data.negative_prompt_storage === "r2" ||
    data.result_storage === "r2" ||
    data.content_storage === "r2"
  ) {
    return data;
  }

  const createdAt = data.created_at ?? context.created_at ?? new Date();
  const [prompt, negativePrompt, result, content] = await Promise.all([
    data.prompt === undefined
      ? Promise.resolve(null)
      : offloadTextField({
          namespace: ObjectNamespaces.GenerationArtifacts,
          organizationId: context.organization_id,
          objectId: context.id,
          field: "prompt",
          createdAt,
          value: data.prompt,
        }),
    data.negative_prompt === undefined
      ? Promise.resolve(null)
      : offloadTextField({
          namespace: ObjectNamespaces.GenerationArtifacts,
          organizationId: context.organization_id,
          objectId: context.id,
          field: "negative_prompt",
          createdAt,
          value: data.negative_prompt,
        }),
    data.result === undefined
      ? Promise.resolve(null)
      : offloadJsonField<Record<string, unknown>>({
          namespace: ObjectNamespaces.GenerationArtifacts,
          organizationId: context.organization_id,
          objectId: context.id,
          field: "result",
          createdAt,
          value: data.result,
          inlineValueWhenOffloaded: null,
        }),
    data.content === undefined
      ? Promise.resolve(null)
      : offloadTextField({
          namespace: ObjectNamespaces.GenerationArtifacts,
          organizationId: context.organization_id,
          objectId: context.id,
          field: "content",
          createdAt,
          value: data.content,
        }),
  ]);

  return {
    ...data,
    ...(prompt
      ? { prompt: prompt.value ?? "", prompt_storage: prompt.storage, prompt_key: prompt.key }
      : {}),
    ...(negativePrompt
      ? {
          negative_prompt: negativePrompt.value,
          negative_prompt_storage: negativePrompt.storage,
          negative_prompt_key: negativePrompt.key,
        }
      : {}),
    ...(result
      ? { result: result.value, result_storage: result.storage, result_key: result.key }
      : {}),
    ...(content
      ? { content: content.value, content_storage: content.storage, content_key: content.key }
      : {}),
  };
}

/**
 * Repository for generation (image/video) database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class GenerationsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a generation by ID.
   */
  async findById(id: string): Promise<Generation | undefined> {
    const generation = await dbRead.query.generations.findFirst({
      where: eq(generations.id, id),
    });
    return generation ? await hydrateGeneration(generation) : undefined;
  }

  /**
   * Finds a generation by job ID.
   */
  async findByJobId(jobId: string): Promise<Generation | undefined> {
    const generation = await dbRead.query.generations.findFirst({
      where: eq(generations.job_id, jobId),
    });
    return generation ? await hydrateGeneration(generation) : undefined;
  }

  /**
   * Lists generations for an organization, ordered by creation date.
   * Always bounded — `limit` defaults to 50 and is clamped to [1, 200].
   */
  async listByOrganization(organizationId: string, limit?: number): Promise<Generation[]> {
    const boundedLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await dbRead.query.generations.findMany({
      where: eq(generations.organization_id, organizationId),
      orderBy: desc(generations.created_at),
      limit: boundedLimit,
    });
    return await Promise.all(rows.map(hydrateGeneration));
  }

  async listByOrganizationSummary(
    organizationId: string,
    limit?: number,
  ): Promise<GenerationSummary[]> {
    const boundedLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await dbRead.query.generations.findMany({
      where: eq(generations.organization_id, organizationId),
      orderBy: desc(generations.created_at),
      limit: boundedLimit,
    });
    return rows.map(toGenerationSummary);
  }

  /**
   * Lists generations for an organization filtered by type.
   */
  async listByOrganizationAndType(
    organizationId: string,
    type: string,
    limit?: number,
  ): Promise<Generation[]> {
    const rows = await dbRead.query.generations.findMany({
      where: and(eq(generations.organization_id, organizationId), eq(generations.type, type)),
      orderBy: desc(generations.created_at),
      limit,
    });
    return await Promise.all(rows.map(hydrateGeneration));
  }

  async listByOrganizationAndTypeSummary(
    organizationId: string,
    type: string,
    limit?: number,
  ): Promise<GenerationSummary[]> {
    const rows = await dbRead.query.generations.findMany({
      where: and(eq(generations.organization_id, organizationId), eq(generations.type, type)),
      orderBy: desc(generations.created_at),
      limit,
    });
    return rows.map(toGenerationSummary);
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

    const rows = await dbRead.query.generations.findMany({
      where: and(...conditions),
      orderBy: desc(generations.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
    return await Promise.all(rows.map(hydrateGeneration));
  }

  async listByOrganizationAndStatusSummary(
    organizationId: string,
    status: string,
    options?: {
      userId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<GenerationSummary[]> {
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

    const rows = await dbRead.query.generations.findMany({
      where: and(...conditions),
      orderBy: desc(generations.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
    return rows.map(toGenerationSummary);
  }

  /**
   * Lists random completed images that users have explicitly marked as public.
   * Only returns images where is_public = true to prevent leaking private generations.
   */
  async listRandomPublicImages(limit: number = 20): Promise<Generation[]> {
    const rows = await dbRead.query.generations.findMany({
      where: and(
        eq(generations.status, "completed"),
        eq(generations.type, "image"),
        eq(generations.is_public, true),
        sql`${generations.storage_url} IS NOT NULL`,
      ),
      orderBy: sql`RANDOM()`,
      limit,
    });
    return await Promise.all(rows.map(hydrateGeneration));
  }

  async listRandomPublicImageSummaries(limit: number = 20): Promise<GenerationSummary[]> {
    const rows = await dbRead.query.generations.findMany({
      where: and(
        eq(generations.status, "completed"),
        eq(generations.type, "image"),
        eq(generations.is_public, true),
        sql`${generations.storage_url} IS NOT NULL`,
      ),
      orderBy: sql`RANDOM()`,
      limit,
    });
    return rows.map(toGenerationSummary);
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
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new generation record.
   */
  async create(data: NewGeneration): Promise<Generation> {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date();
    const insertData = (await prepareGenerationPayload(
      {
        ...data,
        id,
        created_at: createdAt,
      },
      { id, organization_id: data.organization_id, created_at: createdAt },
    )) as NewGeneration;
    const [generation] = await dbWrite.insert(generations).values(insertData).returning();
    return await hydrateGeneration(generation);
  }

  /**
   * Updates an existing generation.
   */
  async update(id: string, data: Partial<NewGeneration>): Promise<Generation | undefined> {
    let updateData = data;
    if (hasPayloadUpdates(data)) {
      const existing = await dbWrite.query.generations.findFirst({
        where: eq(generations.id, id),
      });
      if (!existing) return undefined;
      updateData = (await prepareGenerationPayload(data, {
        id,
        organization_id: data.organization_id ?? existing.organization_id,
        created_at: existing.created_at,
      })) as Partial<NewGeneration>;
    }

    const [updated] = await dbWrite
      .update(generations)
      .set({
        ...updateData,
        updated_at: new Date(),
      })
      .where(eq(generations.id, id))
      .returning();
    return updated ? await hydrateGeneration(updated) : undefined;
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
