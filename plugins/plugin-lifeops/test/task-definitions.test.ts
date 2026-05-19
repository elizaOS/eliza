import { describe, expect, it } from "vitest";
import {
  type ApprovalTaskDefinition,
  type CheckInTaskDefinition,
  compileTaskDefinition,
  type OutputTaskDefinition,
  type ReminderTaskDefinition,
  validateTaskDefinition,
} from "../src/default-packs/index.js";

const base = {
  promptInstructions: "Send a short reminder.",
  trigger: { kind: "manual" as const },
  priority: "low" as const,
  respectsGlobalPause: true,
  source: "default_pack" as const,
  createdBy: "task-definition-test",
  ownerVisible: true,
};

describe("task definitions", () => {
  it("compiles an author-facing reminder definition into a ScheduledTask seed", () => {
    const definition: ReminderTaskDefinition = {
      ...base,
      definitionKind: "reminder",
      idempotencyKey: "default-pack:test:reminder",
    };

    const seed = compileTaskDefinition(definition);

    expect(seed.kind).toBe("reminder");
    expect(seed).not.toHaveProperty("definitionKind");
    expect(seed).not.toHaveProperty("taskId");
    expect(seed).not.toHaveProperty("state");
    expect(seed.idempotencyKey).toBe("default-pack:test:reminder");
  });

  it("rejects incompatible completion checks before pack registration", () => {
    const definition = {
      ...base,
      definitionKind: "approval",
      completionCheck: { kind: "subject_updated" },
      subject: { kind: "document", id: "doc-1" },
      output: {
        destination: "in_app_card",
        target: "approval-queue",
        persistAs: "task_metadata",
      },
    } as ApprovalTaskDefinition;

    const result = validateTaskDefinition(definition);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        'approval task cannot use completionCheck.kind="subject_updated"',
      );
    }
  });

  it("requires check-ins to declare a completion check", () => {
    const definition = {
      ...base,
      definitionKind: "checkin",
    } as CheckInTaskDefinition;

    const result = validateTaskDefinition(definition);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        "checkin task definitions require completionCheck",
      );
    }
  });

  it("requires output definitions to carry channel metadata", () => {
    const definition = {
      ...base,
      definitionKind: "output",
      output: {
        destination: "channel",
        target: "",
        persistAs: "external_only",
      },
    } satisfies OutputTaskDefinition;

    const result = validateTaskDefinition(definition);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        "channel output requires output.target",
      );
    }
  });

  it("requires event-triggered definitions to include shouldFire gates", () => {
    const definition: ReminderTaskDefinition = {
      ...base,
      definitionKind: "reminder",
      trigger: { kind: "event", eventKind: "gmail.message.created" },
    };

    const result = validateTaskDefinition(definition);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        "event trigger must declare shouldFire gates",
      );
    }
  });
});
