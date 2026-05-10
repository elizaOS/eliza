import { describe, expect, it } from "vitest";

import { elizaCloudRoutePlugin } from "../src/plugin";

describe("elizaCloudRoutePlugin", () => {
  it("registers the cloud startup and agent lifecycle routes", () => {
    const routes = new Set(
      (elizaCloudRoutePlugin.routes ?? []).map((route) => `${route.type} ${route.path}`)
    );

    for (const route of [
      "POST /api/cloud/login",
      "GET /api/cloud/billing/:path*",
      "POST /api/cloud/billing/:path*",
      "GET /api/cloud/agents",
      "POST /api/cloud/agents",
      "POST /api/cloud/agents/:agentId/provision",
      "POST /api/cloud/agents/:agentId/connect",
      "POST /api/cloud/agents/:agentId/shutdown",
    ]) {
      expect(routes.has(route)).toBe(true);
    }
  });
});
