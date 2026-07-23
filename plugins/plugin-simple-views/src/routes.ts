/**
 * Authenticated state boundary for managed Cloud Notes and Calendar. Mutations use
 * the shared view-capability broker so direct controls and agent actions cannot
 * drift into parallel transport contracts.
 */

import { isElizaError, type Route, toElizaError } from "@elizaos/core";
import { getSimpleViewsService } from "./service.js";

export const simpleViewsRoutes: Route[] = [
  {
    type: "GET",
    name: "simple-views-state",
    path: "/api/simple-views/state",
    rawPath: true,
    modes: ["cloud"],
    modeReason:
      "the native Notes and Calendar release surfaces are backed by managed Cloud agent state",
    routeHandler: async (context) => {
      try {
        return {
          status: 200,
          body: {
            success: true,
            data: await getSimpleViewsService(context.runtime).snapshot(),
          },
        };
      } catch (error) {
        // error-policy:J1 boundary translation — this authenticated HTTP boundary
        // reports systemic failures and never fabricates an empty state document.
        const normalized = isElizaError(error)
          ? error
          : toElizaError(error, "SIMPLE_VIEWS_ROUTE_FAILED");
        context.runtime.reportError("SimpleViewsRoutes", normalized, {
          method: context.method,
          path: context.path,
        });
        return {
          status:
            normalized.code === "SIMPLE_VIEWS_SERVICE_UNAVAILABLE" ||
            normalized.code === "SIMPLE_VIEWS_STORE_UNAVAILABLE"
              ? 503
              : 500,
          body: {
            success: false,
            error: { code: normalized.code, message: normalized.message },
          },
        };
      }
    },
  },
];
