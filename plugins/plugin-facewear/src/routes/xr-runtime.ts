/**
 * XR runtime route returns desktop OpenXR detection status and install planning
 * for the facewear settings row.
 */
import type { Route } from "@elizaos/core";
import { detectOpenXrRuntimeNow } from "../runtime/node-probe.ts";
import { planOpenXrInstall } from "../runtime/openxr-runtime.ts";

export const facewearXrRuntimeRoute: Route = {
  path: "/api/facewear/xr-runtime",
  type: "GET",
  routeHandler: async (_ctx) => {
    const status = detectOpenXrRuntimeNow();
    const plan = planOpenXrInstall(status);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, plan }),
    };
  },
};
