/**
 * Monetization cloud domain — barrel + route/section registration.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/earnings/*` and
 * `dashboard/affiliates/*` (their `_components` + the `@elizaos/cloud-shared`
 * referral helpers). Monetization = Earnings (redemptions:
 * `GET/POST /api/v1/redemptions` + `/balance` `/quote` `/status`; redeem-to-
 * $ELIZA dialog on base/solana/ethereum/bnb) + Affiliates (referrals:
 * `GET/POST/PUT /api/v1/affiliates`, `GET /api/v1/referrals`).
 *
 * PLAN §3 collapses both `dashboard/earnings` and `dashboard/affiliates` into a
 * single **Monetization** settings section. So:
 *  - {@link MonetizationSection} is the zero-prop merged (Earnings + Affiliates
 *    tabbed) component Wave 3 hands to
 *    `registerSettingsSection({ id: "monetization", Component: MonetizationSection })`.
 *  - Three standalone routes register **at import time** — `dashboard/earnings`,
 *    `dashboard/affiliates` (preserved deep links), and `dashboard/monetization`
 *    (the merged view). None collide with a `CloudRouterShell` redirect, so
 *    eager registration is safe. {@link registerMonetizationCloudRoutes} is
 *    exported for re-registration at custom paths if needed.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export { AffiliatesPageClient } from "./affiliates/AffiliatesPageClient";
export {
  AffiliatesSurface,
  default as AffiliatesRoute,
} from "./affiliates/AffiliatesRoute";
export {
  fetchReferralMe,
  parseReferralMeResponse,
  type ReferralMeResponse,
} from "./affiliates/referral-me";
export { useDashboardReferralMe } from "./affiliates/use-dashboard-referral-me";
export { EarningsPageClient } from "./earnings/EarningsPageClient";
export {
  default as EarningsRoute,
  EarningsSurface,
} from "./earnings/EarningsRoute";
export {
  MonetizationSection,
  MonetizationView,
} from "./MonetizationSection";

/** Stable view/section id + URL path slugs for the monetization surfaces. */
export const MONETIZATION_SECTION_ID = "monetization";
export const MONETIZATION_ROUTE_PATH = "dashboard/monetization";
export const EARNINGS_ROUTE_PATH = "dashboard/earnings";
export const AFFILIATES_ROUTE_PATH = "dashboard/affiliates";

/** Lazy route elements (code-split) for the standalone surfaces. */
const MonetizationRouteLazy = lazy(() => import("./MonetizationRoute"));
const EarningsRouteLazy = lazy(() => import("./earnings/EarningsRoute"));
const AffiliatesRouteLazy = lazy(() => import("./affiliates/AffiliatesRoute"));

/** Cloud-route definitions for the standalone monetization surfaces. */
export const monetizationCloudRoutes: CloudRouteDef[] = [
  {
    path: MONETIZATION_ROUTE_PATH,
    element: MonetizationRouteLazy,
    group: "dashboard",
  },
  { path: EARNINGS_ROUTE_PATH, element: EarningsRouteLazy, group: "dashboard" },
  {
    path: AFFILIATES_ROUTE_PATH,
    element: AffiliatesRouteLazy,
    group: "dashboard",
  },
];

/**
 * Register (or re-register) the standalone monetization routes. Exported for an
 * explicit custom-path mount; the default registration below runs at import time
 * since none of these paths collide with a shell redirect.
 */
export function registerMonetizationCloudRoutes(): void {
  for (const route of monetizationCloudRoutes) {
    registerCloudRoute(route);
  }
}

registerMonetizationCloudRoutes();
