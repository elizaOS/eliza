// Handles v1 cloud API v1 earnings payout stripe connect stripe connect client route traffic with route-local auth expectations.
import type { StripeConnectClient } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import type Stripe from "stripe";

/**
 * Adapt a real Stripe SDK instance to the narrow, SDK-agnostic
 * `StripeConnectClient` the payout service depends on (#8922). Keeping the
 * service decoupled from the SDK lets it be unit-tested without a key; the route
 * passes the live client through this thin shim.
 */
export function toConnectClient(stripe: Stripe): StripeConnectClient {
  return {
    accounts: {
      create: (params) => stripe.accounts.create(params),
    },
    accountLinks: {
      create: (params) => stripe.accountLinks.create(params),
    },
    transfers: {
      create: (params, options) => stripe.transfers.create(params, options),
    },
  };
}
