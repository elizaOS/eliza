/**
 * Canonical opening-balance policy for every Cloud account-creation path.
 *
 * Shared personal Eliza is platform-funded and does not mint user credits.
 * Purchased top-ups, promotion codes, referrals, and historical balances are
 * separate ledger paths and must never be derived from this policy.
 */

export const SIGNUP_CREDIT_POLICY = {
  automaticGrantUsd: 0,
  openingBalanceUsd: "0.00",
} as const;
