import { describe, expect, it } from "vitest";
import {
  buildGoalFollowUp,
  buildGoalPrompt,
  DEFAULT_GOAL_CAPABILITIES,
} from "../../src/services/goal-prompt.ts";

describe("buildGoalPrompt", () => {
  it("wraps the task in goal, capability fence, and completion contract", () => {
    const out = buildGoalPrompt({ goal: "Fix the flaky login test" });
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
    const out = buildGoalPrompt({ goal: "Ship the orchestrator view" });
    const taskIdx = out.indexOf("--- Task ---");
    expect(taskIdx).toBeGreaterThan(-1);
    expect(out.slice(taskIdx)).toContain("Ship the orchestrator view");
  });

  it("uses the explicit task as the first concrete instruction", () => {
    const out = buildGoalPrompt({
      goal: "Keep the build green",
      task: "Start by running the typecheck",
    });
    expect(out).toContain("Keep the build green");
    const taskIdx = out.indexOf("--- Task ---");
    expect(out.slice(taskIdx)).toContain("Start by running the typecheck");
  });

  it("emits acceptance criteria, workspace, and room sections when provided", () => {
    const out = buildGoalPrompt({
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
    const out = buildGoalPrompt({ goal: "Minimal goal" });
    expect(out).not.toContain("--- Acceptance Criteria ---");
    expect(out).not.toContain("--- Workspace ---");
    expect(out).not.toContain("--- Rooms ---");
  });

  it("honours a custom capability fence", () => {
    const out = buildGoalPrompt({
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
