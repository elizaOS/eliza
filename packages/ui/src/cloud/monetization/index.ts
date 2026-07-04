/**
 * Monetization cloud domain — Earnings (redemptions: `GET/POST
 * /api/v1/redemptions` + `/balance` `/quote` `/status`; redeem-to-$ELIZA on
 * base/solana/ethereum/bnb) + Affiliates (referrals: `GET/POST/PUT
 * /api/v1/affiliates`, `GET /api/v1/referrals`), merged into the single tabbed
 * `cloud-monetization` Settings section (`/settings#cloud-monetization`) and
 * the standalone `dashboard/monetization` console page.
 *
 * Legacy `dashboard/{earnings,affiliates}` deep links resolve to the console
 * page via the CloudRouterShell compat redirects.
 */

export { AffiliatesPageClient } from "./affiliates/AffiliatesPageClient";
export { AffiliatesSurface } from "./affiliates/AffiliatesSurface";
export {
  fetchReferralMe,
  parseReferralMeResponse,
  type ReferralMeResponse,
} from "./affiliates/referral-me";
export { useDashboardReferralMe } from "./affiliates/use-dashboard-referral-me";
export { EarningsPageClient } from "./earnings/EarningsPageClient";
export { EarningsSurface } from "./earnings/EarningsSurface";
export {
  MonetizationSection,
  MonetizationView,
} from "./MonetizationSection";
