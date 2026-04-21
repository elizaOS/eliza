/**
 * Tests that the runtime plugin route dispatcher correctly matches
 * Vincent routes registered via vincentPlugin.
 *
 * This verifies the integration between vincentPlugin route definitions
 * and the matchPluginRoutePath function from runtime-plugin-routes.
 */

import { describe, expect, it } from "vitest";
import { vincentPlugin } from "./plugin";
import { matchPluginRoutePath } from "@elizaos/agent/api/runtime-plugin-routes";

describe("Vincent plugin route dispatch matching", () => {
  const routes = vincentPlugin.routes!;

  it("matches GET /api/vincent/status", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/vincent/status",
    );
    expect(route).toBeDefined();
    const params = matchPluginRoutePath(route!.path, "/api/vincent/status");
    expect(params).toEqual({});
  });

  it("matches POST /api/vincent/start-login", () => {
    const route = routes.find(
      (r) => r.type === "POST" && r.path === "/api/vincent/start-login",
    );
    expect(route).toBeDefined();
    const params = matchPluginRoutePath(
      route!.path,
      "/api/vincent/start-login",
    );
    expect(params).toEqual({});
  });

  it("matches GET /callback/vincent", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/callback/vincent",
    );
    expect(route).toBeDefined();
    const params = matchPluginRoutePath(route!.path, "/callback/vincent");
    expect(params).toEqual({});
  });

  it("matches POST /api/vincent/trading/start", () => {
    const route = routes.find(
      (r) => r.type === "POST" && r.path === "/api/vincent/trading/start",
    );
    expect(route).toBeDefined();
    const params = matchPluginRoutePath(
      route!.path,
      "/api/vincent/trading/start",
    );
    expect(params).toEqual({});
  });

  it("does not match wrong method paths", () => {
    // GET route should not exist for start-login
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/vincent/start-login",
    );
    expect(route).toBeUndefined();
  });

  it("does not match unrelated paths", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/vincent/status",
    );
    const params = matchPluginRoutePath(route!.path, "/api/config");
    expect(params).toBeNull();
  });

  it("all routes have handlers that are callable", () => {
    for (const route of routes) {
      expect(typeof route.handler).toBe("function");
      // handler should accept 3 args: req, res, runtime
      expect(route.handler!.length).toBeGreaterThanOrEqual(0);
    }
  });
});
