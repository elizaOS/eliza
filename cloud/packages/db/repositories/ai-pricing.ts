import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AiPricingEntry,
  type AiPricingRefreshRun,
  aiPricingEntries,
  aiPricingRefreshRuns,
  type NewAiPricingEntry,
  type NewAiPricingRefreshRun,
} from "../schemas/ai-pricing";

export type { AiPricingEntry, AiPricingRefreshRun, NewAiPricingEntry, NewAiPricingRefreshRun };

export class AiPricingRepository {
  async listActiveEntries(filters?: {
    billingSource?: string;
    provider?: string;
    model?: string;
    productFamily?: string;
    chargeType?: string;
    sourceKind?: string;
  }): Promise<AiPricingEntry[]> {
    const now = new Date();
    const conditions = [
      eq(aiPricingEntries.is_active, true),
      lte(aiPricingEntries.effective_from, now),
      or(isNull(aiPricingEntries.effective_until), gte(aiPricingEntries.effective_until, now)),
    ];

    if (filters?.billingSource) {
      conditions.push(eq(aiPricingEntries.billing_source, filters.billingSource));
    }
    if (filters?.provider) {
      conditions.push(eq(aiPricingEntries.provider, filters.provider));
    }
    if (filters?.model) {
      conditions.push(eq(aiPricingEntries.model, filters.model));
    }
    if (filters?.productFamily) {
      conditions.push(eq(aiPricingEntries.product_family, filters.productFamily));
    }
    if (filters?.chargeType) {
      conditions.push(eq(aiPricingEntries.charge_type, filters.chargeType));
    }
    if (filters?.sourceKind) {
      conditions.push(eq(aiPricingEntries.source_kind, filters.sourceKind));
    }

    return await dbRead.query.aiPricingEntries.findMany({
      where: and(...conditions),
      orderBy: [desc(aiPricingEntries.priority), desc(aiPricingEntries.effective_from)],
    });
  }

  /** One round-trip for many (provider, model) pairs (same billing source / family / charge type). */
  async listActiveEntriesForProviderModelPairs(filters: {
    billingSource: string;
    productFamily: string;
    chargeType: string;
    pairs: readonly { provider: string; model: string }[];
  }): Promise<AiPricingEntry[]> {
    if (filters.pairs.length === 0) {
      return [];
    }

    const now = new Date();
    const baseConditions = [
      eq(aiPricingEntries.is_active, true),
      lte(aiPricingEntries.effective_from, now),
      or(isNull(aiPricingEntries.effective_until), gte(aiPricingEntries.effective_until, now)),
      eq(aiPricingEntries.billing_source, filters.billingSource),
      eq(aiPricingEntries.product_family, filters.productFamily),
      eq(aiPricingEntries.charge_type, filters.chargeType),
    ];

    const pairConditions = filters.pairs.map((p) =>
      and(eq(aiPricingEntries.provider, p.provider), eq(aiPricingEntries.model, p.model)),
    );

    return await dbRead.query.aiPricingEntries.findMany({
      where: and(...baseConditions, or(...pairConditions)),
      orderBy: [desc(aiPricingEntries.priority), desc(aiPricingEntries.effective_from)],
    });
  }

  async create(entry: NewAiPricingEntry): Promise<AiPricingEntry> {
    const [created] = await dbWrite.insert(aiPricingEntries).values(entry).returning();
    return created;
  }

  async createMany(entries: NewAiPricingEntry[]): Promise<AiPricingEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    return await dbWrite.insert(aiPricingEntries).values(entries).returning();
  }

  async countActiveEntries(): Promise<number> {
    const rows = await dbRead.query.aiPricingEntries.findMany({
      where: eq(aiPricingEntries.is_active, true),
      columns: { id: true },
      limit: 1,
    });

    return rows.length;
  }

  async deactivateEntries(ids: string[], effectiveUntil: Date = new Date()): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const updated = await dbWrite
      .update(aiPricingEntries)
      .set({
        is_active: false,
        effective_until: effectiveUntil,
        updated_at: effectiveUntil,
      })
      .where(and(eq(aiPricingEntries.is_active, true), inArray(aiPricingEntries.id, ids)))
      .returning({ id: aiPricingEntries.id });

    return updated.length;
  }

  async deactivateBySourceKind(
    sourceKind: string,
    effectiveUntil: Date = new Date(),
  ): Promise<number> {
    const updated = await dbWrite
      .update(aiPricingEntries)
      .set({
        is_active: false,
        effective_until: effectiveUntil,
        updated_at: effectiveUntil,
      })
      .where(
        and(eq(aiPricingEntries.is_active, true), eq(aiPricingEntries.source_kind, sourceKind)),
      )
      .returning({ id: aiPricingEntries.id });

    return updated.length;
  }

  async createRefreshRun(run: NewAiPricingRefreshRun): Promise<AiPricingRefreshRun> {
    const [created] = await dbWrite.insert(aiPricingRefreshRuns).values(run).returning();
    return created;
  }

  async createManualOverride(input: {
    billingSource:
      | "gateway"
      | "openrouter"
      | "openai"
      | "groq"
      | "vast"
      | "fal"
      | "elevenlabs"
      | "suno";
    provider: string;
    model: string;
    productFamily:
      | "language"
      | "embedding"
      | "image"
      | "video"
      | "music"
      | "tts"
      | "stt"
      | "voice_clone";
    chargeType: string;
    unit:
      | "token"
      | "image"
      | "request"
      | "second"
      | "minute"
      | "hour"
      | "character"
      | "1k_requests";
    unitPrice: number;
    dimensionKey: string;
    dimensions: Record<string, string | number | boolean | null>;
    reason: string;
    updatedBy: string;
  }): Promise<AiPricingEntry | undefined> {
    const now = new Date();

    const [created] = await dbWrite.transaction(async (tx) => {
      await tx
        .update(aiPricingEntries)
        .set({
          is_active: false,
          effective_until: now,
          updated_at: now,
        })
        .where(
          and(
            eq(aiPricingEntries.is_active, true),
            eq(aiPricingEntries.source_kind, "manual_override"),
            eq(aiPricingEntries.billing_source, input.billingSource),
            eq(aiPricingEntries.provider, input.provider),
            eq(aiPricingEntries.model, input.model),
            eq(aiPricingEntries.product_family, input.productFamily),
            eq(aiPricingEntries.charge_type, input.chargeType),
            eq(aiPricingEntries.dimension_key, input.dimensionKey),
          ),
        );

      return tx
        .insert(aiPricingEntries)
        .values({
          billing_source: input.billingSource,
          provider: input.provider,
          model: input.model,
          product_family: input.productFamily,
          charge_type: input.chargeType,
          unit: input.unit,
          unit_price: input.unitPrice.toString(),
          currency: "USD",
          dimension_key: input.dimensionKey,
          dimensions: input.dimensions,
          source_kind: "manual_override",
          source_url: "admin://manual-override",
          source_hash: null,
          fetched_at: now,
          stale_after: null,
          effective_from: now,
          priority: 1000,
          is_active: true,
          is_override: true,
          updated_by: input.updatedBy,
          metadata: { reason: input.reason },
          updated_at: now,
        })
        .returning();
    });

    return created;
  }

  async updateRefreshRun(
    id: string,
    data: Partial<NewAiPricingRefreshRun>,
  ): Promise<AiPricingRefreshRun | undefined> {
    const [updated] = await dbWrite
      .update(aiPricingRefreshRuns)
      .set(data)
      .where(eq(aiPricingRefreshRuns.id, id))
      .returning();

    return updated;
  }

  async listRecentRefreshRuns(limit: number = 20): Promise<AiPricingRefreshRun[]> {
    return await dbRead.query.aiPricingRefreshRuns.findMany({
      orderBy: [desc(aiPricingRefreshRuns.started_at)],
      limit,
    });
  }
}

export const aiPricingRepository = new AiPricingRepository();
