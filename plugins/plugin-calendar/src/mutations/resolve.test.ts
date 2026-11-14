import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  owner: true,
  queue: { byId: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  execute: vi.fn(),
}));
vi.mock("@elizaos/core", () => ({ hasRoleAccess: async () => s.owner }));
vi.mock("@elizaos/plugin-assistant", () => ({
  createApprovalQueue: () => s.queue,
}));
vi.mock("./execution.js", () => ({
  executeCalendarMutationApproval: s.execute,
}));

import {
  calendarApprovalOutcome,
  resolveCalendarApproval,
  resolveOwnerCalendarApproval,
} from "./resolve.js";

const message = {
  id: "review-message",
  entityId: "owner",
  agentId: "agent",
  createdAt: 1,
} as never;
beforeEach(() => {
  s.owner = true;
  vi.clearAllMocks();
  s.queue.byId.mockResolvedValue({
    id: "review",
    action: "schedule_event",
    state: "pending",
  });
  s.queue.approve.mockResolvedValue({
    id: "review",
    action: "schedule_event",
    state: "approved",
  });
  s.execute.mockResolvedValue({ kind: "succeeded" });
});
it("refuses to approve when the provider execution port is absent", async () => {
  await expect(
    resolveCalendarApproval(
      { agentId: "agent", getService: () => null } as never,
      message,
      { requestId: "review", decision: "approve" },
    ),
  ).rejects.toThrow("Nothing was approved");
  expect(s.queue.approve).not.toHaveBeenCalled();
  expect(s.execute).not.toHaveBeenCalled();
});
it("rejects only an owner-bound Calendar request", async () => {
  await resolveCalendarApproval({ agentId: "agent" } as never, message, {
    requestId: "review",
    decision: "reject",
  });
  expect(s.queue.byId).toHaveBeenCalledWith("review", "owner");
  expect(s.queue.reject).toHaveBeenCalledWith(
    "review",
    "owner",
    expect.anything(),
  );
  expect(s.execute).not.toHaveBeenCalled();
});
it("does not approve other queued action domains", async () => {
  s.queue.byId.mockResolvedValue({ action: "send_email" });
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "approve",
    }),
  ).rejects.toThrow("not found");
  expect(s.queue.approve).not.toHaveBeenCalled();
});
it("executes through the canonical ledger after exact owner approval", async () => {
  const port = { preflight() {}, execute() {} };
  const runtime = { agentId: "agent", getService: () => port } as never;
  await resolveCalendarApproval(runtime, message, {
    requestId: "review",
    decision: "approve",
  });
  expect(s.execute).toHaveBeenCalledWith({
    runtime,
    request: expect.objectContaining({ state: "approved" }),
    port,
  });
});
it("refuses a nonowner before reading the queue", async () => {
  s.owner = false;
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "approve",
    }),
  ).rejects.toThrow("current owner");
  expect(s.queue.byId).not.toHaveBeenCalled();
});

it("rejects malformed decisions before changing a request", async () => {
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "yes" as never,
    }),
  ).rejects.toThrow("exact Calendar request");
  expect(s.queue.approve).not.toHaveBeenCalled();
});

const reviewed = (isReviewed: () => boolean) => ({
  ownerEntityId: "owner",
  requestId: "review",
  decision: "approve" as const,
  resolutionReason: "Owner review dialog",
  isReviewed,
});
it("refuses a reviewed decision when the row changed since the review", async () => {
  const port = { preflight() {}, execute() {} };
  await expect(
    resolveOwnerCalendarApproval(
      { agentId: "agent", getService: () => port } as never,
      reviewed(() => false),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(s.queue.approve).not.toHaveBeenCalled();
  expect(s.execute).not.toHaveBeenCalled();
});
it("refuses a reviewed decision once the row is settled", async () => {
  s.queue.byId.mockResolvedValue({
    id: "review",
    action: "schedule_event",
    state: "done",
  });
  const port = { preflight() {}, execute() {} };
  await expect(
    resolveOwnerCalendarApproval(
      { agentId: "agent", getService: () => port } as never,
      reviewed(() => true),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(s.execute).not.toHaveBeenCalled();
});
it("retries a reviewed row that a refused attempt left retryable", async () => {
  s.queue.byId.mockResolvedValue({
    id: "review",
    action: "schedule_event",
    state: "retryable",
  });
  const port = { preflight() {}, execute() {} };
  await resolveOwnerCalendarApproval(
    { agentId: "agent", getService: () => port } as never,
    reviewed(() => true),
  );
  expect(s.queue.approve).not.toHaveBeenCalled();
  expect(s.execute).toHaveBeenCalledTimes(1);
});
it("reports a lost approval race on a reviewed row as stale", async () => {
  s.queue.approve.mockRejectedValue(new Error("lost race"));
  const port = { preflight() {}, execute() {} };
  await expect(
    resolveOwnerCalendarApproval(
      { agentId: "agent", getService: () => port } as never,
      reviewed(() => true),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(s.execute).not.toHaveBeenCalled();
});
it("executes a reviewed approval that is still pending and unchanged", async () => {
  const port = { preflight() {}, execute() {} };
  await resolveOwnerCalendarApproval(
    { agentId: "agent", getService: () => port } as never,
    reviewed(() => true),
  );
  expect(s.queue.approve).toHaveBeenCalledWith("review", "owner", {
    resolvedBy: "owner",
    resolutionReason: "Owner review dialog",
  });
  expect(s.execute).toHaveBeenCalledTimes(1);
});

describe("owner outcome", () => {
  const failure = (code: string) => ({
    code,
    message: "internal: host stack trace",
    retryable: false,
  });
  it.each([
    [
      {
        kind: "invalidated",
        failure: failure("CALENDAR_MANAGED_TARGET_CHANGED"),
      },
      "Calendar change was not made. The event changed after you reviewed it.",
      { retryable: false, acceptance: "not_accepted" },
    ],
    [
      { kind: "invalidated", failure: failure("CALENDAR_SOMETHING_ELSE") },
      "Calendar change was not made. Nothing was changed.",
      { retryable: false, acceptance: "not_accepted" },
    ],
    [
      { kind: "retryable", failure: failure("CALENDAR_SYNC_RATE_LIMITED") },
      "Calendar change was not made. You can try again.",
      { retryable: true, acceptance: "not_accepted" },
    ],
    [
      { kind: "blocked", reason: "in_flight" },
      "This Calendar change is still in progress.",
      { retryable: false, acceptance: "unknown" },
    ],
    [
      { kind: "blocked", reason: "ambiguous" },
      "Calendar change is not confirmed. Review its saved status before trying again.",
      { code: "CALENDAR_REVIEW_UNCONFIRMED", acceptance: "unknown" },
    ],
  ])("%o", (result, text, expected) => {
    const outcome = calendarApprovalOutcome(result as never);
    expect(outcome.text).toBe(text);
    expect(outcome.failure).toMatchObject(expected);
    expect(JSON.stringify(outcome)).not.toContain("internal");
  });
  it("reports a completed change and a decline without a failure", () => {
    expect(
      calendarApprovalOutcome({
        kind: "succeeded",
        duplicateSuppressed: false,
        receipt: {
          operation: "modify_event",
          eventSnapshot: { title: "Standup" },
        },
      } as never),
    ).toEqual({ text: "Completed Calendar modify event: Standup." });
    expect(calendarApprovalOutcome({ kind: "rejected" })).toEqual({
      text: "Calendar change declined. Nothing was changed.",
    });
  });
});
