/**
 * Types for `subscription-grant.mjs`. See that file for the contract; its
 * exports are annotated with these types and checked by `tsc -p native-host`.
 */

/** Why a subscription code was not redeemed. */
export type RedeemFailureCode =
  | "invalid"
  | "already-redeemed"
  /** The account already pays for a plan, so Cloud refuses the code. */
  | "paid-plan-active"
  /** A replay of a grant that was revoked or whose window has ended. */
  | "ended"
  | "rate-limited"
  | "unavailable"
  | "account";

export declare function normalizeSubscriptionCode(input: string): string | null;

export declare function redeemFailureCode(
  status: number,
  body: unknown,
): RedeemFailureCode | null;

export interface SubscriptionGrantOptions {
  /** Defaults to `Date.now()`. */
  now?: number;
  /** When set, a grant for any other plan is not read. */
  planKeys?: readonly string[];
}

/** The grant a redemption gave. Instants are ISO 8601 UTC strings. */
export interface RedeemedGrant {
  planKey: string;
  startsAt: string;
  /** Exclusive end of the grant window; null is a lifetime grant. */
  endsAt: string | null;
  /** True while an effective paid plan serves instead of the grant. */
  paidPlanTakesPrecedence: boolean;
}

export declare function redeemedSubscriptionGrant(
  data: unknown,
  options?: SubscriptionGrantOptions,
):
  | { status: "redeemed"; replayed: boolean; grant: RedeemedGrant }
  | { status: "ended" }
  | null;

/** The grant's allowance bucket for the month that holds the snapshot clock. */
export interface SubscriptionGrantAllowance {
  periodStart: string;
  periodEnd: string;
  granted: string;
  unreserved: string;
  currency: "USD";
}

export type SubscriptionGrantState =
  | ({ status: "active" } & RedeemedGrant & {
        allowance: SubscriptionGrantAllowance | null;
      })
  | { status: "none" }
  | { status: "unknown" };

export declare function subscriptionGrantFromSnapshot(
  snapshot: unknown,
  options?: SubscriptionGrantOptions,
): SubscriptionGrantState;
