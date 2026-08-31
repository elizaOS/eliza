/**
 * Canonical opening-balance policy for every Cloud account-creation path.
 *
 * Every newly created personal Cloud organization receives one fixed opening
 * balance. Purchased top-ups, promotion codes, referrals, historical balances,
 * and non-signup organization creation remain separate ledger paths.
 */

export const SIGNUP_CREDIT_POLICY = {
  automaticGrantUsd: 5,
  openingBalanceUsd: "5.00",
} as const;
