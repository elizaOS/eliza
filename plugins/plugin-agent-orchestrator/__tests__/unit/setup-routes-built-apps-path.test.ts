/**
 * Verifies setup-routes — the built-apps path templates are registered.
 * Deterministic unit test of the exported route table; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";

// Guards the same registration gap as setup-routes-credential-paths.test.ts and
// setup-routes-task-detail-paths.test.ts, this time for the built-apps registry
// surface (#12036 / #13268). Its handler is implemented in
// api/orchestrator-routes.ts (dispatched before the service gate) but the path
// was never listed in CODING_AGENT_ROUTE_PATHS, so the runtime route matcher —
// which needs an exact path template — never reached it and it 404'd over real
// HTTP ({"error":"Not found"}) while sibling routes like
// GET /api/orchestrator/tasks answered 200. That 404 breaks the app-management
// flow end to end: a bot-built app registers into the durable registry at task
// completion, but no client can ever list or remove it.
describe("setup-routes — built-apps path templates are registered", () => {
  const has = (type: string, path: string) =>
    (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === type && r.path === path,
    );

  it("registers the built-apps template the management list requires", () => {
    expect(has("GET", "/api/orchestrator/built-apps")).toBe(true);
  });

  it("registers the built-apps delete template the management surface requires", () => {
    expect(has("DELETE", "/api/orchestrator/built-apps/:target/:slug")).toBe(
      true,
    );
  });
});
