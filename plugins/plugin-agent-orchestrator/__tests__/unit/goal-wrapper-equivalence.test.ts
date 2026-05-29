import { describe, expect, it } from "vitest";
import { buildGoalPrompt } from "../../src/services/goal-prompt.ts";

// Proves the goal-wrapper unification did not let the planner-action envelope
// drift from the direct-API envelope. The API route calls
// buildGoalPrompt({ goal, workdir, taskRoomId, worktreeRoomId }); the planner
// action adapter (taskWithResolvedRoute) calls buildGoalPrompt with the same
// core fields plus optional swarmRooms/route extras. The envelopes are
// byte-identical ONLY when the action passes no swarmRooms/route extras (second
// case); the real planner path adds a "Known swarm rooms:" line (first case),
// so it is NOT byte-identical to the API path in production — only its
// pre-Rooms prefix is.
describe("goal-wrapper envelope equivalence (action spawn == API spawn)", () => {
  const goal = "Refactor the parser";
  const workdir = "/srv/work";
  const taskRoomId = "room-task";

  it("API-shape and action-shape inputs share the same core sections", () => {
    const apiEnvelope = buildGoalPrompt({ goal, workdir, taskRoomId });
    const actionEnvelope = buildGoalPrompt({
      goal,
      task: goal,
      workdir,
      taskRoomId,
      swarmRooms: [{ roomId: taskRoomId, roles: ["task"] }],
    });

    for (const header of [
      "--- Goal ---",
      "--- Workspace ---",
      "--- Rooms ---",
      "--- Capabilities ---",
      "--- Working Agreement ---",
      "--- Task ---",
    ]) {
      expect(apiEnvelope).toContain(header);
      expect(actionEnvelope).toContain(header);
    }

    // Everything up to the Rooms section (the Goal and Workspace sections;
    // Capabilities is emitted after Rooms) is identical between entry points.
    const upTo = (s: string, h: string) => s.slice(0, s.indexOf(h));
    expect(upTo(actionEnvelope, "--- Rooms ---")).toBe(
      upTo(apiEnvelope, "--- Rooms ---"),
    );
    // The action envelope's only Rooms addition is the known-swarm-rooms list.
    expect(actionEnvelope).toContain("Known swarm rooms:");
    expect(apiEnvelope).not.toContain("Known swarm rooms:");
  });

  it("byte-identical when the action passes no extra swarm/route fields", () => {
    const apiEnvelope = buildGoalPrompt({ goal, workdir, taskRoomId });
    const actionEnvelope = buildGoalPrompt({
      goal,
      task: goal,
      workdir,
      taskRoomId,
    });
    expect(actionEnvelope).toBe(apiEnvelope);
  });
});
