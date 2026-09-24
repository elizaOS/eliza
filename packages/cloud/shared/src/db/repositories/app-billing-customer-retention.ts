/** Validates customer retention under canonical scope, survivor and deletion-phase locks. This read-only decision permits skipping customer deletion; it never certifies phase completion or grants access. */
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import type { AppBillingDeletionRecoveryAuthority } from "./app-billing-deletion-authority";
import { appBillingConflict } from "./app-subscription-authority";

export async function retainSharedAppBillingCustomer(input: {
  customerBindingId: string;
  authority: AppBillingDeletionRecoveryAuthority;
}): Promise<void> {
  if (input.authority.kind !== "account_deletion")
    appBillingConflict("Canonical deletion authority is required for customer retention");
  try {
    await writeTransaction(async (tx) => {
      const auth = input.authority;
      await tx.execute(
        sql`SELECT require_app_billing_customer_retention(${input.customerBindingId}::uuid,${auth.requestId}::uuid,${auth.requestDigest},${auth.lifecycleRevision}::bigint,${auth.phaseReceiptId}::uuid,${auth.phaseGeneration}::bigint)`,
      );
    });
  } catch (error) {
    // error-policy:J2 Preserve the canonical database rejection at the retention boundary.
    throw new ElizaError(
      "Customer retention requires current canonical decisions and survivor authority",
      {
        code: "APP_BILLING_CUSTOMER_RETENTION_REJECTED",
        cause: error,
        context: { customerBindingId: input.customerBindingId },
      },
    );
  }
}
