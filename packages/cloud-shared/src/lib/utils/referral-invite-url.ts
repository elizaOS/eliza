/**
 * Builds the login URL used for referral attribution (`ref` query param).
 *
 * WHY a single helper: Same shape is used in the Affiliates card, inactive state, copy handler,
 * and header Invite button—avoids drift if we add `intent=signup` or rename params later.
 * Login also honors `referral_code`; we standardize on `ref` for share links (see app/login).
 */
export function buildReferralInviteLoginUrl(origin: string, code: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/login?ref=${encodeURIComponent(code)}`;
}
