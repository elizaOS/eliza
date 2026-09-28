/**
 * Stripe Connect account status for creators (#8922).
 *
 * Creator payouts are retired (#23022): onboarding and transfers were removed
 * and their routes answer 410. Only the webhook status mapping remains so the
 * Connect webhook keeps historical connected-account rows current.
 */

import type { StripeConnectStatus } from "../../db/schemas/stripe-connect-accounts";

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
