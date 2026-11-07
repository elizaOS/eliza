/** Original quote-owned settings. Callers hold the quote lock before binding or reading. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { organizationScheduleQuoteTermsSchema } from "../../lib/services/organization-schedule-quote-terms";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { organizationScheduleQuoteTerms as terms } from "../schemas/organization-schedule-quote-terms";
export async function readOriginalScheduleQuoteTerms(
  tx: DbTransaction,
  quoteId: string,
  organizationId: string,
) {
  const [row] = await tx
    .select()
    .from(terms)
    .where(and(eq(terms.quote_id, quoteId), eq(terms.organization_id, organizationId)))
    .for("update");
  if (!row) return null;
  const parsed = organizationScheduleQuoteTermsSchema.safeParse(row.snapshot);
  if (
    !parsed.success ||
    settlementDigest(parsed.data) !== row.snapshot_digest ||
    settlementDigest(row.snapshot) !== row.snapshot_digest
  )
    throw new ElizaError("Original retained schedule terms changed", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  return { ...row, snapshot: parsed.data };
}
