/** Tool-family rules ride with their tools on the planner surface (#31017). */

import { describe, expect, it } from "vitest";
import {
  buildPlannerTemplate,
  plannerRequiredPolicy,
  plannerTemplate,
  plannerToolScopedPolicy,
  plannerToolScopedRules,
} from "../../prompts/planner";

const shellRule = plannerToolScopedPolicy.recallTools.rule;
const tasksRule = plannerToolScopedPolicy.codingDelegation.rule;
const webRule = "- For a single live/current/public lookup";

describe("planner tool-scoped rules", () => {
  it("keeps every rule when the surface is unknown", () => {
    expect(plannerToolScopedRules()).toEqual([shellRule, tasksRule]);
    for (const rule of [shellRule, tasksRule, webRule])
      expect(plannerTemplate).toContain(rule);
  });

  it("omits tool-family rules for a surface without those families", () => {
    const template = buildPlannerTemplate({
      nativeToolsOnly: true,
      toolNames: ["GREET_USER", "DISCOVER_ACTIONS", "REPLY"],
    });
    expect(plannerToolScopedRules(["GREET_USER", "DISCOVER_ACTIONS"])).toEqual(
      [],
    );
    for (const rule of [shellRule, tasksRule, webRule])
      expect(template).not.toContain(rule);
    for (const rule of Object.values(plannerRequiredPolicy))
      expect(template).toContain(rule);
  });

  it("brings each rule with its exposed family", () => {
    expect(plannerToolScopedRules(["SHELL"])).toEqual([shellRule]);
    expect(plannerToolScopedRules(["TASKS_SPAWN_AGENT"])).toEqual([tasksRule]);
    expect(plannerToolScopedRules(["TASKS"])).toEqual([tasksRule]);
    const web = buildPlannerTemplate({
      nativeToolsOnly: true,
      toolNames: ["WEB_SEARCH"],
    });
    expect(web).toContain(webRule);
    expect(web).not.toContain(shellRule);
    expect(web).not.toContain(tasksRule);
    const coding = buildPlannerTemplate({
      nativeToolsOnly: true,
      toolNames: ["SHELL", "TASKS"],
    });
    for (const rule of [shellRule, tasksRule, webRule])
      expect(coding).toContain(rule);
  });
});
