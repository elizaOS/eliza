/**
 * Verifies setup-routes — task detail + control path templates are registered.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";

// Guards the same registration gap as setup-routes-credential-paths.test.ts,
// this time for the task-scoped detail + control routes. Their handlers are
// implemented in api/orchestrator-routes.ts (`sub === "timeline"`,
// `"auto-validate"`, `"retry-turn"`, `"rerun-from-event"`, `"restart"`,
// `"restart-with-edited-plan"`, `"plan-revisions"`) but were NEVER listed in
// CODING_AGENT_ROUTE_PATHS, so the runtime route matcher — which needs an
// exact path template — never reached them and they 404'd over real HTTP.
//
// The `/timeline` 404 was the load-bearing failure: the orchestrator UI's
// `useOrchestratorData.fetchDetail` does
// `Promise.all([getCodingAgentTaskThread, listOrchestratorTaskTimeline])`, so a
// 404 on timeline rejected the whole fetch and every task-detail pane hung on
// "Loading task…", making the Approve/Reject/Restart controls unreachable.
describe("setup-routes — task detail + control path templates are registered", () => {
  const has = (type: string, path: string) =>
    (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === type && r.path === path,
    );

  it("registers the timeline template the detail pane requires", () => {
    expect(has("GET", "/api/orchestrator/tasks/:taskId/timeline")).toBe(true);
  });

  it("registers every implemented task-scoped control template", () => {
    const expected: Array<[string, string]> = [
      ["POST", "/api/orchestrator/tasks/:taskId/auto-validate"],
      ["POST", "/api/orchestrator/tasks/:taskId/retry-turn"],
      ["POST", "/api/orchestrator/tasks/:taskId/rerun-from-event"],
      ["POST", "/api/orchestrator/tasks/:taskId/restart"],
      ["POST", "/api/orchestrator/tasks/:taskId/restart-with-edited-plan"],
      ["GET", "/api/orchestrator/tasks/:taskId/plan-revisions"],
      ["POST", "/api/orchestrator/tasks/:taskId/plan-revisions"],
    ];
    for (const [type, path] of expected) {
      expect(has(type, path), `${type} ${path} must be registered`).toBe(true);
    }
  });

  it("keeps the sibling detail templates registered (validate/events/usage)", () => {
    expect(has("POST", "/api/orchestrator/tasks/:taskId/validate")).toBe(true);
    expect(has("GET", "/api/orchestrator/tasks/:taskId/events")).toBe(true);
    expect(has("GET", "/api/orchestrator/tasks/:taskId/usage")).toBe(true);
  });
});
