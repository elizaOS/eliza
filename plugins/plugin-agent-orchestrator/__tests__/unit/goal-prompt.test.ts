/**
 * Verifies buildGoalPrompt.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  buildGoalFollowUp,
  buildGoalPrompt,
  DEFAULT_GOAL_CAPABILITIES,
} from "../../src/services/goal-prompt.ts";

describe("buildGoalPrompt", () => {
  it("tells the agent its assigned name in the goal section", () => {
    const out = buildGoalPrompt({
      agentName: "Sakuya",
      goal: "Fix the flaky login test",
    });
    expect(out).toContain(
      "You are Sakuya, an autonomous coding sub-agent working as part of a swarm",
    );
  });

  it("wraps the task in goal, capability fence, and completion contract", () => {
    const out = buildGoalPrompt({
      agentName: "Reimu",
      goal: "Fix the flaky login test",
    });
    expect(out).toContain("--- Goal ---");
    expect(out).toContain("Fix the flaky login test");
    expect(out).toContain("--- Capabilities ---");
    expect(out).toContain(DEFAULT_GOAL_CAPABILITIES.join(", "));
    expect(out).toContain("--- Working Agreement ---");
    expect(out).toContain(
      "Do not report the task finished until the goal is genuinely complete",
    );
    expect(out).toContain("--- Task ---");
  });

  it("defaults the concrete task to the goal when omitted", () => {
    const out = buildGoalPrompt({
      agentName: "Marisa",
      goal: "Ship the orchestrator view",
    });
    const taskIdx = out.indexOf("--- Task ---");
    expect(taskIdx).toBeGreaterThan(-1);
    expect(out.slice(taskIdx)).toContain("Ship the orchestrator view");
  });

  it("uses the explicit task as the first concrete instruction", () => {
    const out = buildGoalPrompt({
      agentName: "Youmu",
      goal: "Keep the build green",
      task: "Start by running the typecheck",
    });
    expect(out).toContain("Keep the build green");
    const taskIdx = out.indexOf("--- Task ---");
    expect(out.slice(taskIdx)).toContain("Start by running the typecheck");
  });

  it("emits acceptance criteria, workspace, and room sections when provided", () => {
    const out = buildGoalPrompt({
      agentName: "Yukari",
      goal: "Add pagination",
      acceptanceCriteria: ["cursor-based", "stable ordering"],
      workdir: "/work/repo",
      repo: "elizaos/eliza",
      taskRoomId: "room-task",
      worktreeRoomId: "room-tree",
    });
    expect(out).toContain("--- Acceptance Criteria ---");
    expect(out).toContain("- cursor-based");
    expect(out).toContain("- stable ordering");
    expect(out).toContain("--- Workspace ---");
    expect(out).toContain("Workdir: /work/repo");
    expect(out).toContain("Repo: elizaos/eliza");
    expect(out).toContain("--- Rooms ---");
    expect(out).toContain("room-task");
    expect(out).toContain("room-tree");
  });

  it("omits optional sections when their inputs are absent", () => {
    const out = buildGoalPrompt({ agentName: "Koakuma", goal: "Minimal goal" });
    expect(out).not.toContain("--- Acceptance Criteria ---");
    expect(out).not.toContain("--- Workspace ---");
    expect(out).not.toContain("--- Rooms ---");
  });

  it("honours a custom capability fence", () => {
    const out = buildGoalPrompt({
      agentName: "Reisen",
      goal: "Audit deps",
      allowedCapabilities: ["read files only"],
    });
    expect(out).toContain(
      "Use only coding-relevant capabilities: read files only.",
    );
    expect(out).not.toContain(DEFAULT_GOAL_CAPABILITIES.join(", "));
  });
});

describe("buildGoalFollowUp", () => {
  it("re-anchors a user follow-up to the durable goal and contract", () => {
    const out = buildGoalFollowUp({
      goal: "Migrate to the new schema",
      message: "Also drop the legacy column",
    });
    expect(out).toContain("--- Continue Goal ---");
    expect(out).toContain(
      "The task creator sent a follow-up while you work the goal below",
    );
    expect(out).toContain("Migrate to the new schema");
    expect(out).toContain("--- Working Agreement ---");
    expect(out).toContain("--- Message ---");
    expect(out).toContain("Also drop the legacy column");
  });

  it("frames validation_failed follow-ups distinctly", () => {
    const out = buildGoalFollowUp({
      goal: "Fix the regression",
      message: "Tests 3 and 4 still fail",
      reason: "validation_failed",
    });
    expect(out).toContain(
      "Validation of your previous completion did not pass",
    );
    expect(out).not.toContain(
      "The task creator sent a follow-up while you work the goal below",
    );
  });

  it("includes the task room when provided", () => {
    const out = buildGoalFollowUp({
      goal: "Wire telemetry",
      message: "Use the usage_update event",
      taskRoomId: "room-task",
      reason: "orchestrator",
    });
    expect(out).toContain("--- Rooms ---");
    expect(out).toContain("room-task");
  });
});

// Live 2026-08-21, task 5c6d85c0 "demo-hello": the goal was the planner's
// short label and the verifier's findings never reached the builder, so every
// validation-failed retry rebuilt the bare label and re-parked. The follow-up
// must carry the verbatim ask and the newest findings COMPLETE.
describe("buildGoalFollowUp original request + verifier findings", () => {
  const VERBATIM =
    "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date, deploy it";
  const FINDINGS = [
    "The deliverable lacks both the requested gradient and the current date.",
    "Unmet criteria:",
    "- the page serves the requested content",
  ].join("\n");

  it("renders the verbatim original request and the verifier findings as sections", () => {
    const out = buildGoalFollowUp({
      goal: "demo-hello app",
      message: "Automatic verification did not confirm the task is complete.",
      acceptanceCriteria: ["the live URL is reachable"],
      reason: "validation_failed",
      originalRequest: VERBATIM,
      verifierFindings: FINDINGS,
    });
    expect(out).toContain("--- Original Request ---");
    // PROMPT-INTEGRITY: complete, verbatim, no truncation.
    expect(out).toContain(VERBATIM);
    expect(out).toContain("--- Verifier Findings ---");
    expect(out).toContain(
      "The deliverable lacks both the requested gradient and the current date.",
    );
    expect(out).toContain("- the page serves the requested content");
    // Ordering: request before criteria, findings after criteria, both before
    // the raw correction message.
    expect(out.indexOf("--- Original Request ---")).toBeLessThan(
      out.indexOf("--- Acceptance Criteria ---"),
    );
    expect(out.indexOf("--- Acceptance Criteria ---")).toBeLessThan(
      out.indexOf("--- Verifier Findings ---"),
    );
    expect(out.indexOf("--- Verifier Findings ---")).toBeLessThan(
      out.indexOf("--- Message ---"),
    );
  });

  it("omits both sections when the inputs are absent", () => {
    const out = buildGoalFollowUp({
      goal: "demo-hello app",
      message: "keep going",
      reason: "validation_failed",
    });
    expect(out).not.toContain("--- Original Request ---");
    expect(out).not.toContain("--- Verifier Findings ---");
  });

  it("skips the request section when the goal already carries the verbatim ask", () => {
    const out = buildGoalFollowUp({
      goal: `Deliver this: ${VERBATIM}`,
      message: "continue",
      reason: "validation_failed",
      originalRequest: VERBATIM,
    });
    expect(out).not.toContain("--- Original Request ---");
  });
});

describe("buildGoalPrompt original request", () => {
  const VERBATIM =
    "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date, deploy it";

  it("renders the verbatim ask when the goal/task only carry the short label", () => {
    const out = buildGoalPrompt({
      agentName: "Chen",
      goal: "demo-hello app",
      task: "demo-hello page",
      originalRequest: VERBATIM,
    });
    expect(out).toContain("--- Original Request ---");
    expect(out).toContain(VERBATIM);
    expect(out.indexOf("--- Original Request ---")).toBeLessThan(
      out.indexOf("--- Task ---"),
    );
  });

  it("skips the section when the task text already contains the verbatim ask", () => {
    const out = buildGoalPrompt({
      agentName: "Chen",
      goal: "demo-hello app",
      task: `demo-hello page\n\n${VERBATIM}`,
      originalRequest: VERBATIM,
    });
    expect(out).not.toContain("--- Original Request ---");
  });
});
