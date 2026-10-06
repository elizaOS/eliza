import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const ANALYTICS_ROUTE_PATH = "cloud/analytics";

const AnalyticsPage = lazy(() => import("./AnalyticsPage"));

export { AnalyticsPage };

registerCloudRoute({
  path: ANALYTICS_ROUTE_PATH,
  element: AnalyticsPage,
  group: "cloud",
});
