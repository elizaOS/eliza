/** Bounded, restart-safe selection for the existing Stripe legacy adoption lane. */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { stripeLegacyAdoptionCursors as cursors } from "../schemas/stripe-legacy-adoption-cursors";

export const LEGACY_STRIPE_ADOPTION_BATCH_SIZE = 25;

/**
 * Reserves a selection hint, not the entries themselves. Advance by the first
 * selected digest so a time budget that permits only one attempt cannot skip
 * the remainder forever. Duplicate selection is safe: SQL owns adoption.
 */
export async function selectLegacyStripeAdoptionDigests(
  sourceKey: string,
  digests: readonly string[],
): Promise<{ digests: string[]; revision: bigint } | null> {
  if (digests.length === 0) return null;
  const ordered = [...new Set(digests)].sort();
  return writeTransaction(async (tx) => {
    await tx.insert(cursors).values({ source_key: sourceKey }).onConflictDoNothing();
    const [cursor] = await tx
      .select()
      .from(cursors)
      .where(eq(cursors.source_key, sourceKey))
      .for("update");
    if (!cursor)
      throw new ElizaError("Legacy Stripe selection hint is unavailable", {
        code: "STRIPE_LEGACY_CURSOR_UNAVAILABLE",
      });
    const after =
      cursor.cursor_digest === null
        ? -1
        : ordered.findIndex((digest) => digest > cursor.cursor_digest!);
    const start = Math.max(after, 0);
    const selected = [...ordered.slice(start), ...ordered.slice(0, start)].slice(
      0,
      LEGACY_STRIPE_ADOPTION_BATCH_SIZE,
    );
    const [updated] = await tx
      .update(cursors)
      .set({
        cursor_digest: selected[0],
        revision: sql`${cursors.revision} + 1`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(eq(cursors.source_key, sourceKey))
      .returning({ revision: cursors.revision });
    if (!updated)
      throw new ElizaError("Legacy Stripe selection hint was not persisted", {
        code: "STRIPE_LEGACY_CURSOR_NOT_PERSISTED",
      });
    return { digests: selected, revision: updated.revision };
  });
}

/** Move only this reservation's hint past work it actually attempted. */
export async function finishLegacyStripeAdoptionSelection(
  sourceKey: string,
  revision: bigint,
  lastAttemptedDigest: string,
): Promise<boolean> {
  return writeTransaction(async (tx) => {
    const changed = await tx
      .update(cursors)
      .set({
        cursor_digest: lastAttemptedDigest,
        revision: sql`${cursors.revision} + 1`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(and(eq(cursors.source_key, sourceKey), eq(cursors.revision, revision)))
      .returning({ key: cursors.source_key });
    return changed.length === 1;
  });
}
