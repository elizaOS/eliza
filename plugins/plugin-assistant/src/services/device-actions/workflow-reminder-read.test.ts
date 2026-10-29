import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateDeviceOperation, validateDevicePayload } from "./contract.ts";
import {
  validateWorkflowReadOperation,
  validateWorkflowReadResult,
  type WorkflowReadOperation,
} from "./workflow-contract.ts";

const operation = {
  type: "read_selected_reminders",
  window: "open_and_completed_today",
  day: "2026-10-08",
  timeZone: "America/Los_Angeles",
  maximumItems: 3,
} as const;
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const row = (
  id: string,
  title: string,
  dueAt: string,
  status: "open" | "completed",
  completedAt?: string,
) => ({
  id,
  revision: sha([id, title, dueAt, status, completedAt ?? null]),
  title,
  dueAt,
  status,
  ...(completedAt ? { completedAt } : {}),
});
const binding = {
  workflowId: "wf-1",
  versionId: "ver-1",
  runId: "run-1",
  stepId: "reminders",
  specDigest: "a".repeat(64),
};

describe("workflow selected-reminders read", () => {
  it("accepts only the exact reviewed scope", () => {
    expect(validateWorkflowReadOperation(operation)).toEqual(operation);
    expect(validateDeviceOperation(operation)).toEqual(operation);
    for (const changed of [
      { ...operation, window: "all_reminders" },
      { ...operation, day: "2026-02-30" },
      { ...operation, timeZone: "Not/AZone" },
      { ...operation, maximumItems: 201 },
      { ...operation, includeBodies: true },
    ])
      expect(() => validateWorkflowReadOperation(changed)).toThrow(
        /Invalid reminder read scope/,
      );
  });

  it("is a workflow-bound read, never a standalone device action", () => {
    const payload = {
      action: "device_action",
      version: 1,
      installationId: "install-1",
      enrollmentId: "enroll-1",
      operation,
    };
    expect(() => validateDevicePayload(payload)).toThrow(
      /Workflow read binding required/,
    );
    expect(validateDevicePayload({ ...payload, workflow: binding }).workflow)
      .toEqual(binding);
  });

  it("validates rows against the owner-day window and their revisions", () => {
    const op = operation as WorkflowReadOperation;
    const open = row("open", "Overdue", "2026-10-07T16:00:00.000Z", "open");
    const done = row(
      "done",
      "Done today",
      "2026-10-08T15:00:00.000Z",
      "completed",
      "2026-10-08T20:00:00.000Z",
    );
    expect(
      validateWorkflowReadResult(op, { kind: "reminders", reminders: [open, done] }),
    ).toEqual({ kind: "reminders", reminders: [open, done] });
    const refused = (reminders: unknown[]) =>
      expect(() =>
        validateWorkflowReadResult(op, { kind: "reminders", reminders }),
      ).toThrow();
    refused([row("later", "Tomorrow", "2026-10-09T07:00:00.000Z", "open")]);
    refused([
      row(
        "old",
        "Yesterday",
        "2026-10-07T15:00:00.000Z",
        "completed",
        "2026-10-08T06:59:59.000Z",
      ),
    ]);
    refused([{ ...open, title: "Changed" }]);
    refused([{ ...open, notes: "private" }]);
    refused([open, done, open, done]);
  });
});
