/** Reads hosting admission funds from primary cash and currently spendable subscription allowance in one transaction. Actual provisioning still reserves funds atomically before provider work. */
import { eq } from "drizzle-orm";
import { writeTransaction } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { readEligibleSubscriptionAllowance } from "../../db/repositories/subscription-allowance-eligibility";
import { organizations } from "../../db/schemas/organizations";

export async function readAgentFundingAccount(organizationId: string) {
  return writeTransaction(async (tx) => {
    const [organization] = await tx
      .select({
        credit_balance: organizations.credit_balance,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");
    if (!organization) return null;
    const now = await readPostLockDatabaseNow(tx);
    const allowance = await readEligibleSubscriptionAllowance(tx, organizationId, now, false);
    return {
      ...organization,
      eligible_subscription_allowance: allowance ? allowance.available_amount : "0.000000",
    };
  });
}
