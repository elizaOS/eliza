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

import { resolveCalendarApproval } from "./resolve.js";

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
