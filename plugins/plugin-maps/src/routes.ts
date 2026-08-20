/**
 * Authenticated state boundary for the routed /maps view. Reads return the
 * validated snapshot DTO; interaction goes through the shared view-capability
 * broker so the mounted view and chat never grow parallel transports.
 */

import { isElizaError, type Route, toElizaError } from "@elizaos/core";
import { getMapsService } from "./service.js";
import { buildMapsViewSnapshot } from "./view-state.js";

export const mapsRoutes: Route[] = [
  {
    type: "GET",
    name: "maps-state",
    path: "/api/maps/state",
    rawPath: true,
    modes: ["local", "local-only", "cloud", "remote"],
    modeReason:
      "Maps provider registration and saved places are owned by the active runtime in every supported topology",
    routeHandler: async (context) => {
      try {
        return {
          status: 200,
          body: {
            success: true,
            data: await buildMapsViewSnapshot(
              context.runtime,
              getMapsService(context.runtime),
            ),
          },
        };
      } catch (error) {
        // error-policy:J1 boundary translation — this authenticated HTTP
        // boundary reports systemic failures and never fabricates an empty
        // snapshot.
        const normalized = isElizaError(error)
          ? error
          : toElizaError(error, "MAPS_ROUTE_FAILED");
        context.runtime.reportError("MapsRoutes", normalized, {
          method: context.method,
          path: context.path,
        });
        return {
          status:
            normalized.code === "MAPS_PROVIDER_UNAVAILABLE" ||
            normalized.code === "MAPS_STORAGE_FAILURE"
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
