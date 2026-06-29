import type { Route } from "@elizaos/core";
import { detectOpenXrRuntimeNow } from "../runtime/node-probe.ts";
import { planOpenXrInstall } from "../runtime/openxr-runtime.ts";

/**
 * `GET /api/facewear/xr-runtime` — the desktop OpenXR runtime status + an install
 * plan when none is active. The FacewearView "VR/AR runtime" row reads this; the
 * SETUP_XR_RUNTIME action formats the same data for chat.
 */
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
