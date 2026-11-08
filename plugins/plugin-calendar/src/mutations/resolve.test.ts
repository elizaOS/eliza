import { beforeEach, expect, it, vi } from "vitest";

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
  calendarApprovalRevision,
  resolveCalendarApproval,
  resolveReviewedCalendarApproval,
} from "./resolve.js";

const message = {
  id: "review-message",
  entityId: "owner",
  agentId: "agent",
  createdAt: 1,
} as never;
const row = {
  id: "review",
  subjectUserId: "owner",
  action: "schedule_event",
  state: "pending",
  payload: { calendarId: "primary", title: "QA" },
  reason: "Schedule QA",
  expiresAt: new Date("2026-11-09T00:00:00.000Z"),
  updatedAt: new Date("2026-11-08T00:00:00.000Z"),
};
const port = { preflight() {}, execute() {} };
const reviewed = (decision: "approve" | "reject", revision?: string) => ({
  requestId: "review",
  decision,
  revision: revision ?? calendarApprovalRevision(row as never),
  ownerEntityId: "owner",
  resolutionReason: "Owner review dialog",
});
beforeEach(() => {
  s.owner = true;
  vi.clearAllMocks();
  s.queue.byId.mockResolvedValue(row);
  s.queue.approve.mockResolvedValue({ ...row, state: "approved" });
  s.execute.mockResolvedValue({ kind: "succeeded" });
});
it("matches the revision a client derives from the approvals DTO", () => {
  expect(calendarApprovalRevision(row as never)).toBe(
    JSON.stringify([
      "review",
      "owner",
      "pending",
      "schedule_event",
      { calendarId: "primary", title: "QA" },
      "Schedule QA",
      "2026-11-09T00:00:00.000Z",
      "2026-11-08T00:00:00.000Z",
    ]),
  );
});
it("never approves from an owner chat message", async () => {
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "approve",
    }),
  ).rejects.toThrow("review dialog");
  expect(s.queue.byId).not.toHaveBeenCalled();
  expect(s.queue.approve).not.toHaveBeenCalled();
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
it("does not reject other queued action domains", async () => {
  s.queue.byId.mockResolvedValue({ ...row, action: "send_email" });
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "reject",
    }),
  ).rejects.toThrow("not found");
  expect(s.queue.reject).not.toHaveBeenCalled();
});
it("refuses a nonowner before reading the queue", async () => {
  s.owner = false;
  await expect(
    resolveCalendarApproval({ agentId: "agent" } as never, message, {
      requestId: "review",
      decision: "reject",
    }),
  ).rejects.toThrow("current owner");
  expect(s.queue.byId).not.toHaveBeenCalled();
});
it("executes through the canonical ledger after a reviewed approval", async () => {
  const runtime = { agentId: "agent", getService: () => port } as never;
  await resolveReviewedCalendarApproval(runtime, reviewed("approve"));
  expect(s.queue.approve).toHaveBeenCalledWith("review", "owner", {
    resolvedBy: "owner",
    resolutionReason: "Owner review dialog",
  });
  expect(s.execute).toHaveBeenCalledWith({
    runtime,
    request: expect.objectContaining({ state: "approved" }),
    port,
  });
});
it("refuses a stale revision without approving", async () => {
  const runtime = { agentId: "agent", getService: () => port } as never;
  await expect(
    resolveReviewedCalendarApproval(
      runtime,
      reviewed("approve", calendarApprovalRevision({
        ...row,
        payload: { calendarId: "primary", title: "Changed" },
      } as never)),
    ),
  ).rejects.toMatchObject({ status: 409, code: "CALENDAR_APPROVAL_CHANGED" });
  expect(s.queue.approve).not.toHaveBeenCalled();
  expect(s.execute).not.toHaveBeenCalled();
});
it("refuses a settled request without executing again", async () => {
  s.queue.byId.mockResolvedValue({ ...row, state: "approved" });
  const runtime = { agentId: "agent", getService: () => port } as never;
  await expect(
    resolveReviewedCalendarApproval(runtime, reviewed("approve")),
  ).rejects.toMatchObject({ status: 409, code: "CALENDAR_APPROVAL_SETTLED" });
  expect(s.execute).not.toHaveBeenCalled();
});
it("refuses to approve when the provider execution port is absent", async () => {
  await expect(
    resolveReviewedCalendarApproval(
      { agentId: "agent", getService: () => null } as never,
      reviewed("approve"),
    ),
  ).rejects.toThrow("Nothing was approved");
  expect(s.queue.approve).not.toHaveBeenCalled();
  expect(s.execute).not.toHaveBeenCalled();
});
it("rejects malformed decisions before changing a request", async () => {
  await expect(
    resolveReviewedCalendarApproval({ agentId: "agent" } as never, {
      ...reviewed("approve"),
      decision: "yes" as never,
    }),
  ).rejects.toThrow("exact Calendar request");
  expect(s.queue.approve).not.toHaveBeenCalled();
});
