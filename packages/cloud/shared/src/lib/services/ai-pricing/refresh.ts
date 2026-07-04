// Coordinates cloud service refresh behavior behind route handlers.
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../../db/helpers";
import { aiPricingRepository } from "../../../db/repositories/ai-pricing";
import { aiPricingEntries, aiPricingRefreshRuns } from "../../../db/schemas/ai-pricing";
import { logger } from "../../utils/logger";
import { toDbEntry } from "./dimensions";
import { fetchBitRouterCatalogEntries } from "./providers/bitrouter";
import { fetchElevenLabsEntries } from "./providers/elevenlabs";
import { fetchFalCatalogEntries } from "./providers/fal";
import { fetchSunoEntries } from "./providers/suno";
import { fetchVastSnapshotEntries } from "./providers/vast";
import {
  BITROUTER_MODELS_URL,
  type PreparedPricingEntry,
  type PricingRefreshSource,
} from "./types";

async function refreshSourceEntries(
  source: PricingRefreshSource,
  sourceUrl: string,
  loader: () => Promise<PreparedPricingEntry[]>,
): Promise<{
  source: PricingRefreshSource;
  fetchedEntries: number;
  upsertedEntries: number;
  deactivatedEntries: number;
  success: boolean;
  error?: string;
}> {
  const startedAt = new Date();
  const [run] = await dbWrite
    .insert(aiPricingRefreshRuns)
    .values({
      source,
      status: "running",
      source_url: sourceUrl,
      started_at: startedAt,
      metadata: {},
    })
    .returning();

  try {
    const entries = await loader();
    if (entries.length === 0) {
      throw new Error(`No pricing entries fetched from ${source}`);
    }

    const now = new Date();
    const dbEntries = entries.map((entry) => toDbEntry(entry, now));

    const currentActiveRows = await aiPricingRepository.listActiveEntries({
      sourceKind: dbEntries[0]?.source_kind ?? source,
    });

    await dbWrite.transaction(async (tx) => {
      // Full snapshot replace for this source_kind: every active row is deactivated,
      // then the freshly fetched catalog is inserted. Stale product_family values
      // (e.g. token rows previously stored as "image") are not left active alongside
      // corrected rows; there is no partial upsert keyed only on model + charge_type.
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
            eq(aiPricingEntries.source_kind, dbEntries[0].source_kind),
          ),
        );

      await tx.insert(aiPricingEntries).values(dbEntries);

      await tx
        .update(aiPricingRefreshRuns)
        .set({
          status: "completed",
          fetched_entries: entries.length,
          upserted_entries: dbEntries.length,
          deactivated_entries: currentActiveRows.length,
          completed_at: new Date(),
        })
        .where(eq(aiPricingRefreshRuns.id, run.id));
    });

    return {
      source,
      fetchedEntries: entries.length,
      upsertedEntries: dbEntries.length,
      deactivatedEntries: currentActiveRows.length,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[AI Pricing] Refresh failed", { source, error: message });

    await dbWrite
      .update(aiPricingRefreshRuns)
      .set({
        status: "failed",
        error: message,
        completed_at: new Date(),
      })
      .where(eq(aiPricingRefreshRuns.id, run.id));

    return {
      source,
      fetchedEntries: 0,
      upsertedEntries: 0,
      deactivatedEntries: 0,
      success: false,
      error: message,
    };
  }
}

export async function refreshPricingCatalog(
  sources: PricingRefreshSource[] = ["bitrouter", "fal", "elevenlabs", "vast"],
) {
  const results = [];

  if (sources.includes("bitrouter")) {
    results.push(
      await refreshSourceEntries("bitrouter", BITROUTER_MODELS_URL, async () => {
        return await fetchBitRouterCatalogEntries();
      }),
    );
  }

  if (sources.includes("fal")) {
    results.push(
      await refreshSourceEntries("fal", "https://fal.ai/models", async () => {
        return await fetchFalCatalogEntries();
      }),
    );
  }

  if (sources.includes("elevenlabs")) {
    results.push(
      await refreshSourceEntries("elevenlabs", "https://elevenlabs.io/pricing/api", async () => {
        return await fetchElevenLabsEntries();
      }),
    );
  }

  if (sources.includes("suno")) {
    results.push(
      await refreshSourceEntries("suno", "https://docs.sunoapi.org/suno-api/", async () => {
        return await fetchSunoEntries();
      }),
    );
  }

  if (sources.includes("vast")) {
    results.push(
      await refreshSourceEntries("vast", "internal://vast/pricing", async () => {
        return await fetchVastSnapshotEntries();
      }),
    );
  }

  return {
    success: results.every((result) => result.success),
    results,
    refreshedAt: new Date().toISOString(),
  };
}
