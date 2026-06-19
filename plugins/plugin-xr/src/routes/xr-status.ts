import type { Route } from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

export const xrStatusRoute: Route = {
  type: "GET",
  path: "/xr/status",
  description: "Returns the list of connected XR devices and session state",
  routeHandler: async (ctx) => {
    const svc = ctx.runtime.getService<XRSessionService>(XR_SERVICE_TYPE);

    if (!svc) {
      return {
        status: 503,
        body: { error: "XR service not running" },
      };
    }

    const conns = svc.getConnections().map((c) => ({
      id: c.id,
      deviceType: c.deviceType,
      connectedAt: c.connectedAt.toISOString(),
      hasRecentFrame: svc.getVisionPipeline().hasRecentFrame(c.id),
    }));

    return {
      status: 200,
      body: {
        connected: conns.length > 0,
        connections: conns,
      },
    };
  },
};
