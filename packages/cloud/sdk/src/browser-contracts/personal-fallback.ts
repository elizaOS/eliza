/** Public account-state DTO for Personal Shared fallback and signed recovery links. */

export const PERSONAL_FALLBACK_ACCOUNT_REASONS = [
  "billing_suspended",
  "subscription_payment_failed",
  "subscription_ended",
] as const;
export type PersonalFallbackAccountReason =
  (typeof PERSONAL_FALLBACK_ACCOUNT_REASONS)[number];

export interface PersonalSharedFallbackAccountState {
  access: "shared_fallback";
  /** `recovery_pending` once billing is restored and Dedicated is restarting. */
  state: "shared_active" | "recovery_pending";
  reason: PersonalFallbackAccountReason;
  /** Dedicated memory stays unavailable until billing is restored. */
  dedicatedMemory: "unavailable";
  generation: number;
  /** ISO time through which the stopped Dedicated agent is preserved, when policy sets one. */
  dedicatedRetainedUntil: string | null;
  /** Signed-in billing surface; a checkout redirect alone never restores access. */
  recoveryAction: {
    kind: "restore_subscription" | "add_credits";
    path: "/cloud/billing";
    /**
     * Signed, expiring link that resolves to `/cloud/billing` with the
     * organization context. It carries no payment details and grants nothing:
     * the billing page still requires the signed-in owner.
     */
    link?: PersonalFallbackRecoveryLink;
  };
}

export interface PersonalFallbackRecoveryLink {
  url: string;
  expiresAt: string;
}
