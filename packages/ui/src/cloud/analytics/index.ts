/**
 * Analytics cloud domain — per-user usage + cost view.
 *
 * Mounts at `/dashboard/analytics` (the canonical home; cloud-frontend's
 * degraded `settings analytics-tab` is intentionally not ported). The route is
 * code-split via `React.lazy` so the recharts/date-fns chart bundle only loads
 * when the view is opened.
 *
 * The Wave-3 settings section and the app shell consume {@link AnalyticsPage}
 * (default export) / this module's `registerCloudRoute` side effect.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const ANALYTICS_ROUTE_PATH = "dashboard/analytics";

const AnalyticsPage = lazy(() => import("./Page"));

export {
  type AnalyticsTimeRange,
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "./lib/analytics-data";
export {
  ANALYTICS_TIME_RANGES,
  DEFAULT_ANALYTICS_TIME_RANGE,
  projectionPeriodsForRange,
  resolveTimeRangeParam,
} from "./lib/time-range";
export { AnalyticsPage };

registerCloudRoute({
  path: ANALYTICS_ROUTE_PATH,
  element: AnalyticsPage,
  group: "dashboard",
});
