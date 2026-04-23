/**
 * Tests that the runtime plugin route dispatcher correctly matches
 * Vincent routes registered via vincentPlugin.
 *
 * This verifies the integration between vincentPlugin route definitions
 * and the matchPluginRoutePath function from runtime-plugin-routes.
 */

import { matchPluginRoutePath } from "@elizaos/agent/api/runtime-plugin-routes";
import { describe, expect, it } from "vitest";
import { vincentPlugin } from "./plugin";

describe("Vincent plugin route dispatch matching", () => {
  const routes = vincentPlugin.routes ?? [];

  function requireRoute(type: string, path: string) {
    const route = routes.find(
      (item) => item.type === type && item.path === path,
    );
    if (!route) {
      throw new Error(`Expected ${type} ${path} route`);
    }
    return route;
  }

  it("matches GET /api/vincent/status", () => {
    const route = requireRoute("GET", "/api/vincent/status");
    const params = matchPluginRoutePath(route.path, "/api/vincent/status");
    expect(params).toEqual({});
  });

  it("matches POST /api/vincent/start-login", () => {
    const route = requireRoute("POST", "/api/vincent/start-login");
    const params = matchPluginRoutePath(route.path, "/api/vincent/start-login");
    expect(params).toEqual({});
  });

  it("matches GET /callback/vincent", () => {
    const route = requireRoute("GET", "/callback/vincent");
    const params = matchPluginRoutePath(route.path, "/callback/vincent");
    expect(params).toEqual({});
  });

  it("does not match wrong method paths", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/vincent/start-login",
    );
    expect(route).toBeUndefined();
  });

  it("does not expose removed legacy or fake execution routes", () => {
    const removedPaths = [
      "/api/vincent/register",
      "/api/vincent/token",
      "/api/vincent/vault-status",
      "/api/vincent/trading/start",
      "/api/vincent/trading/stop",
    ];
    for (const path of removedPaths) {
      expect(routes.find((route) => route.path === path)).toBeUndefined();
    }
  });

  it("does not match unrelated paths", () => {
    const route = requireRoute("GET", "/api/vincent/status");
    const params = matchPluginRoutePath(route.path, "/api/config");
    expect(params).toBeNull();
  });

  it("all routes have handlers that are callable", () => {
    for (const route of routes) {
      expect(typeof route.handler).toBe("function");
      expect(route.handler?.length).toBeGreaterThanOrEqual(0);
    }
  });
});
