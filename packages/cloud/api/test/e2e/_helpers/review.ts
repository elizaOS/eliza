/**
 * Test helpers for the app compliance-review gate (#10732).
 *
 * The e2e test process shares the database with the running Worker, so it can
 * approve an app directly for suites that exercise charging/monetization rather
 * than the review gate itself. Approving with a null content hash mirrors the
 * grandfathered state the backfill migration produces.
 */
import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { eq } from "drizzle-orm";

export async function approveAppInDb(appId: string): Promise<void> {
  await dbWrite
    .update(apps)
    .set({
      review_status: "approved",
      review_content_hash: null,
      reviewed_at: new Date(),
    })
    .where(eq(apps.id, appId));
}

/** True when a language-model provider is configured so the classifier can run live. */
export function hasReviewModel(): boolean {
  const hasKey =
    Boolean(process.env.CEREBRAS_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.GROQ_API_KEY) ||
    Boolean(process.env.OPENROUTER_API_KEY);
  return hasKey;
}
