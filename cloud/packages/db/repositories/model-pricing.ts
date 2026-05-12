import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type ModelPricing, modelPricing, type NewModelPricing } from "../schemas/model-pricing";

export type { ModelPricing, NewModelPricing };

/**
 * Repository for model pricing database operations.
 */
export class ModelPricingRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds active pricing for a model and provider combination.
   */
  async findByModelAndProvider(model: string, provider: string): Promise<ModelPricing | undefined> {
    return await dbRead.query.modelPricing.findFirst({
      where: and(
        eq(modelPricing.model, model),
        eq(modelPricing.provider, provider),
        eq(modelPricing.is_active, true),
      ),
    });
  }

  /**
   * Finds model pricing by ID.
   */
  async findById(id: string): Promise<ModelPricing | undefined> {
    return await dbRead.query.modelPricing.findFirst({
      where: eq(modelPricing.id, id),
    });
  }

  /**
   * Lists all active model pricing records.
   */
  async listActive(): Promise<ModelPricing[]> {
    return await dbRead.query.modelPricing.findMany({
      where: eq(modelPricing.is_active, true),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new model pricing record.
   */
  async create(data: NewModelPricing): Promise<ModelPricing> {
    const [pricing] = await dbWrite.insert(modelPricing).values(data).returning();
    return pricing;
  }

  /**
   * Updates an existing model pricing record.
   */
  async update(id: string, data: Partial<NewModelPricing>): Promise<ModelPricing | undefined> {
    const [updated] = await dbWrite
      .update(modelPricing)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(modelPricing.id, id))
      .returning();
    return updated;
  }
}

/**
 * Singleton instance of ModelPricingRepository.
 */
export const modelPricingRepository = new ModelPricingRepository();
