/**
 * Stripe Connect accounts repository (#8922).
 *
 * CQRS split: reads → `dbRead`, writes → `dbWrite`. Persists the creator↔
 * connected-account linkage + capability flags that the payout routes read for
 * onboarding/transfer and that webhooks advance. Balances are NOT here — they
 * live in the redeemable-earnings ledger.
 */

import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewStripeConnectAccount,
  type StripeConnectAccount,
  type StripeConnectStatus,
  stripeConnectAccounts,
} from "../schemas/stripe-connect-accounts";

export class StripeConnectAccountsRepository {
  async findByUserId(userId: string): Promise<StripeConnectAccount | undefined> {
    const rows = await dbRead
      .select()
      .from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.user_id, userId))
      .limit(1);
    return rows[0];
  }

  async findByAccountId(accountId: string): Promise<StripeConnectAccount | undefined> {
    const rows = await dbRead
      .select()
      .from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.stripe_connect_account_id, accountId))
      .limit(1);
    return rows[0];
  }

  /** Insert a new linkage, or update the account id for an existing user. */
  async upsert(input: NewStripeConnectAccount): Promise<void> {
    await dbWrite
      .insert(stripeConnectAccounts)
      .values(input)
      .onConflictDoUpdate({
        target: stripeConnectAccounts.user_id,
        set: {
          stripe_connect_account_id: input.stripe_connect_account_id,
          updated_at: new Date(),
        },
      });
  }

  /** Advance status / capability flags from a webhook or capability refresh. */
  async updateByAccountId(
    accountId: string,
    patch: {
      status?: StripeConnectStatus;
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
    },
  ): Promise<void> {
    await dbWrite
      .update(stripeConnectAccounts)
      .set({ ...patch, updated_at: new Date() })
      .where(eq(stripeConnectAccounts.stripe_connect_account_id, accountId));
  }
}

export const stripeConnectAccountsRepository = new StripeConnectAccountsRepository();
