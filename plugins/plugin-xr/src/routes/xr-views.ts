import type { Route } from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

/**
 * GET /api/xr/views
 * Returns all XR-typed views from registered plugins.
 * Used by app-xr to populate the view launcher.
 */
export const xrViewsRoute: Route = {
  type: "GET",
  path: "/xr/views",
  description: "Lists all XR-capable views from registered plugins",
  routeHandler: async (ctx) => {
    const plugins =
      (
        ctx.runtime as unknown as {
          plugins?: Array<{
            name?: string;
            views?: Array<{
              id: string;
              label: string;
              viewType?: string;
              icon?: string;
              description?: string;
              tags?: string[];
              xrOptions?: Record<string, unknown>;
            }>;
          }>;
        }
      ).plugins ?? [];

    const views: Array<{
      id: string;
      label: string;
      icon?: string;
      description?: string;
      tags?: string[];
      xrOptions?: Record<string, unknown>;
    }> = [];

    const seen = new Set<string>();
    for (const plugin of plugins) {
      for (const v of plugin.views ?? []) {
        if (v.viewType === "xr" && !seen.has(v.id)) {
          seen.add(v.id);
          views.push({
            id: v.id,
            label: v.label,
            icon: v.icon,
            description: v.description,
            tags: v.tags,
            xrOptions: v.xrOptions,
          });
        }
      }
    }

    const connections =
      ctx.runtime
        .getService<XRSessionService>(XR_SERVICE_TYPE)
        ?.getConnections()
        .map((c) => ({ id: c.id, deviceType: c.deviceType })) ?? [];

    return {
      status: 200,
      body: { views, connections, count: views.length },
    };
  },
};
