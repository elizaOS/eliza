/**
 * Regression contract test ensuring wave1-types re-exports match @elizaos/plugin-scheduling.
 */
import type {
  ScheduledTask as CanonicalScheduledTask,
  ScheduledTaskInput as CanonicalScheduledTaskInput,
  ScheduledTaskRef as CanonicalScheduledTaskRef,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRef,
} from "../src/lifeops/wave1-types.ts";

describe("wave1-types contracts", () => {
  it("type assignability round-trips with canonical scheduled-task shapes", () => {
    const input: ScheduledTaskInput = {
      kind: "reminder",
      promptInstructions: "Check in with the user",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
    };

    const canonicalInput: CanonicalScheduledTaskInput = input;
    expect(canonicalInput.kind).toBe("reminder");
    expect(canonicalInput.priority).toBe("medium");
  });

  it("preserves the previously local-only executionProfile and output.fallback fields", () => {
    const input: ScheduledTaskInput = {
      kind: "reminder",
      promptInstructions: "Check in with the user",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
      executionProfile: "bg-heavy-fgs",
      output: {
        destination: "in_app_card",
        fallback: { title: "Reminder", body: "Your reminder is ready." },
      },
    };

    const canonicalInput: CanonicalScheduledTaskInput = input;
    expect(canonicalInput.executionProfile).toBe("bg-heavy-fgs");
    expect(canonicalInput.output?.fallback?.body).toBe(
      "Your reminder is ready.",
    );

    const backToLocal: ScheduledTaskInput = canonicalInput;
    expect(backToLocal.output?.fallback?.title).toBe("Reminder");
  });

  it("accepts input-shaped pipeline children the way default packs declare them", () => {
    const child: ScheduledTaskInput = {
      kind: "reminder",
      promptInstructions: "Follow up on the check-in",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
    };
    const parent: ScheduledTaskInput = {
      kind: "checkin",
      promptInstructions: "Run the morning check-in",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
      pipeline: { onSkip: [child] },
    };

    const ref: ScheduledTaskRef = child;
    const canonicalRef: CanonicalScheduledTaskRef = ref;
    expect(parent.pipeline?.onSkip).toHaveLength(1);
    expect(canonicalRef).toBe(child);
  });

  it("accepts full canonical tasks wherever the local task type is used", () => {
    const canonical: CanonicalScheduledTask = {
      taskId: "task-1",
      kind: "reminder",
      promptInstructions: "Check in with the user",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
      state: {
        status: "scheduled",
        followupCount: 0,
      },
    };

    const local: ScheduledTask = canonical;
    expect(local.taskId).toBe("task-1");
    expect(local.state.status).toBe("scheduled");
  });
});
