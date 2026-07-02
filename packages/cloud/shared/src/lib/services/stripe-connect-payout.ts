/**
 * Stripe Connect fiat payout for creators (#8922).
 *
 * Business logic for paying creator earnings to a connected bank account via
 * Stripe Connect Express, as an alternative to the on-chain token-redemption
 * path (`payout-processor.ts`). The money math + balance debit stays in the
 * redeemable-earnings ledger (the single source of truth) — this module only
 * orchestrates the Stripe side: onboarding, transfers, and webhook status.
 *
 * The Stripe SDK is injected (`StripeConnectClient`) rather than imported, so the
 * flow is fully unit-testable without a live key and the route layer passes
 * `requireStripe()` at the boundary.
 */

import type { StripeConnectStatus } from "../../db/schemas/stripe-connect-accounts";

/** Payout currency. Kept inline (not imported from `../stripe`) so this module
 * stays SDK-agnostic — it never loads the Stripe SDK; the route injects the
 * client. Matches `STRIPE_CURRENCY` in `../stripe`. */
const STRIPE_CURRENCY = "usd";

/** Minimal structural subset of the Stripe SDK this module uses. */
export interface StripeConnectClient {
  accounts: {
    create(params: {
      type: "express";
      email?: string;
      metadata?: Record<string, string>;
    }): Promise<{ id: string }>;
  };
  accountLinks: {
    create(params: {
      account: string;
      refresh_url: string;
      return_url: string;
      type: "account_onboarding";
    }): Promise<{ url: string }>;
  };
  transfers: {
    create(
      params: {
        amount: number;
        currency: string;
        destination: string;
        metadata?: Record<string, string>;
      },
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string }>;
  };
}

export interface OnboardingInput {
  userId: string;
  email?: string;
  /** Where Stripe returns the user if the link expires before completion. */
  refreshUrl: string;
  /** Where Stripe returns the user after onboarding. */
  returnUrl: string;
  /** Reuse an existing connected account instead of creating a new one. */
  existingAccountId?: string;
}

export interface OnboardingResult {
  accountId: string;
  onboardingUrl: string;
  /** True when a fresh Express account was created (caller persists it). */
  created: boolean;
}

/**
 * Create (or reuse) an Express connected account and return a one-time
 * onboarding URL. The caller persists `accountId` on first creation.
 */
export async function createConnectOnboarding(
  stripe: StripeConnectClient,
  input: OnboardingInput,
): Promise<OnboardingResult> {
  let accountId = input.existingAccountId;
  let created = false;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: input.email,
      metadata: { userId: input.userId },
    });
    accountId = account.id;
    created = true;
  }
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: "account_onboarding",
  });
  return { accountId, onboardingUrl: link.url, created };
}

/** Convert a USD amount to integer Stripe cents, rejecting invalid values. */
export function usdToStripeCents(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`Invalid payout amount: ${amountUsd}`);
  }
  return Math.round(amountUsd * 100);
}

export interface TransferInput {
  accountId: string;
  amountUsd: number;
  /** Stable key so a retried withdraw never double-pays. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/**
 * Transfer funds to a connected account. Assumes the caller has already run the
 * existing withdraw validations (creator role, monetization on, balance ≥
 * amount) and debited the ledger atomically — this is the Stripe side only.
 */
export async function transferToConnectAccount(
  stripe: StripeConnectClient,
  input: TransferInput,
): Promise<{ transferId: string; amountCents: number }> {
  const amountCents = usdToStripeCents(input.amountUsd);
  const transfer = await stripe.transfers.create(
    {
      amount: amountCents,
      currency: STRIPE_CURRENCY,
      destination: input.accountId,
      metadata: input.metadata,
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return { transferId: transfer.id, amountCents };
}

/** Derive the account status enum from Stripe capability flags. */
export function connectStatusFromCapabilities(caps: {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  disabled?: boolean;
  requirementsDue?: boolean;
}): StripeConnectStatus {
  if (caps.disabled) return "disabled";
  if (caps.charges_enabled && caps.payouts_enabled) return "active";
  if (caps.requirementsDue) return "restricted";
  return "pending";
}

export type ConnectPayoutStatus = "in_transit" | "paid";

export interface ConnectWebhookOutcome {
  /** Connected account the event concerns, when present. */
  accountId?: string;
  /** Payout lifecycle the event advances to, for `transfer.created`/`payout.paid`. */
  payoutStatus?: ConnectPayoutStatus;
  /** Account capability refresh, for `account.updated`. */
  status?: StripeConnectStatus;
  /**
   * Raw capability booleans from `account.updated`. Persisted alongside `status`
   * so the DB column reflects reality: the payout transfer gate reads
   * `payouts_enabled` directly, and it defaults false — deriving only `status`
   * from these and dropping the booleans left `payouts_enabled` false forever,
   * rejecting every fiat payout (#11172).
   */
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  /** True when the event type isn't one we act on. */
  ignored: boolean;
}

/**
 * Pure mapping of a Stripe Connect webhook event to the status change it implies.
 * The route persists the outcome; keeping this pure makes it fully testable.
 */
export function mapConnectWebhookEvent(event: {
  type: string;
  account?: string;
  data?: { object?: Record<string, unknown> };
}): ConnectWebhookOutcome {
  switch (event.type) {
    case "transfer.created":
      return { accountId: event.account, payoutStatus: "in_transit", ignored: false };
    case "payout.paid":
      return { accountId: event.account, payoutStatus: "paid", ignored: false };
    case "account.updated": {
      const obj = event.data?.object ?? {};
      const chargesEnabled = obj.charges_enabled === true;
      const payoutsEnabled = obj.payouts_enabled === true;
      return {
        accountId: event.account,
        status: connectStatusFromCapabilities({
          charges_enabled: chargesEnabled,
          payouts_enabled: payoutsEnabled,
        }),
        chargesEnabled,
        payoutsEnabled,
        ignored: false,
      };
    }
    default:
      return { ignored: true };
  }
}
