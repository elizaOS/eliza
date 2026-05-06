import { type IAgentRuntime, runWithTrajectoryContext } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  TRAJECTORY_PARENT_STEP_ENV_KEY,
  TRAJECTORY_PARENT_STEP_METADATA_KEY,
  withLinkedSpawn,
} from "../services/spawn-trajectory.js";

function makeRuntime() {
  const annotateStep = vi.fn(async () => undefined);
  const trajectoryLogger = {
    startTrajectory: vi.fn(async () => "trajectory-1"),
    annotateStep,
    isEnabled: vi.fn(() => true),
  };
  const runtime = {
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : undefined,
    ),
    getServicesByType: vi.fn(() => []),
  } as unknown as IAgentRuntime;

  return { runtime, annotateStep };
}

describe("spawn trajectory linkage", () => {
  it("adds parent step metadata and links the spawned child id", async () => {
    const { runtime, annotateStep } = makeRuntime();

    const result = await runWithTrajectoryContext(
      { trajectoryStepId: "parent-step-34" },
      () =>
        withLinkedSpawn(
          runtime,
          {
            source: "test-spawn",
            metadata: { label: "child-task" },
            env: { EXISTING: "1" },
            childId: (session) => session.id,
          },
          async (spawn) => {
            expect(spawn.parentStepId).toBe("parent-step-34");
            expect(spawn.metadata).toMatchObject({
              label: "child-task",
              trajectoryLinkSource: "test-spawn",
              [TRAJECTORY_PARENT_STEP_METADATA_KEY]: "parent-step-34",
            });
            expect(spawn.env).toMatchObject({
              EXISTING: "1",
              [TRAJECTORY_PARENT_STEP_ENV_KEY]: "parent-step-34",
            });
            return { id: "child-session-1" };
          },
        ),
    );

    expect(result.id).toBe("child-session-1");
    expect(annotateStep).toHaveBeenCalledWith({
      stepId: "parent-step-34",
      appendChildSteps: ["child-session-1"],
    });
  });

  it("runs unchanged when no trajectory step is active", async () => {
    const { runtime, annotateStep } = makeRuntime();

    const result = await withLinkedSpawn(
      runtime,
      {
        source: "test-spawn",
        metadata: { label: "child-task" },
        env: { EXISTING: "1" },
        childId: (session) => session.id,
      },
      async (spawn) => {
        expect(spawn.parentStepId).toBeUndefined();
        expect(spawn.metadata).toEqual({ label: "child-task" });
        expect(spawn.env).toEqual({ EXISTING: "1" });
        return { id: "child-session-2" };
      },
    );

    expect(result.id).toBe("child-session-2");
    expect(annotateStep).not.toHaveBeenCalled();
  });
});
