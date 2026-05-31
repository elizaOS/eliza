import { describe, expect, it } from "vitest";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";

// Guards the gap where handleBridgeRoutes was dispatched internally (routes.ts)
// but its path templates were never registered in CODING_AGENT_ROUTE_PATHS, so
// the runtime route matcher — which requires an exact-segment-count template —
// never reached the bridge over real HTTP. The dispatcher-level test
// (routes-bridge-dispatch.test.ts) could not catch this because it calls the
// dispatcher directly, bypassing the registry. This asserts the registration.
describe("setup-routes — credential bridge path templates are registered", () => {
  const has = (type: string, path: string) =>
    (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === type && r.path === path,
    );

  it("registers the credential request + retrieve templates", () => {
    expect(
      has("POST", "/api/coding-agents/:sessionId/credentials/request"),
    ).toBe(true);
    expect(has("GET", "/api/coding-agents/:sessionId/credentials/:key")).toBe(
      true,
    );
  });

  it("keeps the sibling parent-context bridge template registered", () => {
    expect(has("GET", "/api/coding-agents/:sessionId/parent-context")).toBe(
      true,
    );
  });
});
