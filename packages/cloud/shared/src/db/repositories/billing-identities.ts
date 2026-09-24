/** Resolves retained billing provenance for an already-authorized user. Identity anchors never replace live-user, lifecycle, or membership authorization checks. */
import { ElizaError } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { billingIdentitySubjects } from "../schemas/billing-identities";

export async function ensureBillingIdentitySubject(tx: DbTransaction, userId: string) {
  await tx.execute(sql`SELECT ensure_billing_identity_subject(${userId}::uuid)`);
  const [subject] = await tx
    .select()
    .from(billingIdentitySubjects)
    .where(eq(billingIdentitySubjects.id, userId));
  if (!subject || subject.live_user_id !== userId)
    throw new ElizaError("Billing identity requires its original live user", {
      code: "BILLING_IDENTITY_USER_UNAVAILABLE",
    });
  return subject;
}

/** Returns historical provenance, including an explicit null when its login identity has been erased. */
export async function readBillingIdentitySubject(tx: DbTransaction, subjectId: string) {
  const [subject] = await tx
    .select()
    .from(billingIdentitySubjects)
    .where(eq(billingIdentitySubjects.id, subjectId));
  return subject ?? null;
}
