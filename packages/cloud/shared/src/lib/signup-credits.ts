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
  legacyOpeningBalanceUsd: 0,
} as const;

/**
 * Identifies an opening balance that has never been debited or topped up.
 * The zero-dollar case remains valid only for provisional accounts created
 * before the five-dollar policy rollout.
 */
export function isUntouchedSignupOpeningBalance(input: {
  balanceUsd: number;
  balanceRevision: number;
}): boolean {
  return (
    input.balanceRevision === 0 &&
    (input.balanceUsd === SIGNUP_CREDIT_POLICY.legacyOpeningBalanceUsd ||
      input.balanceUsd === SIGNUP_CREDIT_POLICY.automaticGrantUsd)
  );
}
