import type http from "node:http";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { beforeEach, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  execute: vi.fn(),
}));
// In-memory queue with the store's compare-and-set on state.
vi.mock("@elizaos/plugin-assistant", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createApprovalQueue: () => {
    const transition = async (id: string, subject: string, to: string) => {
      const row = s.rows.get(id);
      if (!row || row.subjectUserId !== subject || row.state !== "pending")
        throw new Error("lost race");
      const next = { ...row, state: to, updatedAt: new Date(Date.now() + 1) };
      s.rows.set(id, next);
      return { ...next };
    };
    return {
      byId: async (id: string, subject: string) => {
        const row = s.rows.get(id);
        return row && row.subjectUserId === subject ? { ...row } : null;
      },
      approve: (id: string, subject: string) =>
        transition(id, subject, "approved"),
      reject: (id: string, subject: string) =>
        transition(id, subject, "rejected"),
    };
  },
}));
vi.mock("@elizaos/plugin-calendar", async () => ({
  resolveOwnerCalendarApproval: (
    await import("../../../../plugins/plugin-calendar/src/mutations/resolve.ts")
  ).resolveOwnerCalendarApproval,
}));
vi.mock(
  "../../../../plugins/plugin-calendar/src/mutations/execution.ts",
  () => ({ executeCalendarMutationApproval: s.execute }),
);

import { approvalRevision, handleApprovalRoute } from "./approval-routes.ts";

const port = { preflight() {}, execute() {} };
const runtime = {
  agentId: "00000000-0000-4000-8000-000000000001",
  getSetting: () => null,
  getService: (name: string) =>
    name === "calendar_mutation_port" ? port : null,
};
const owner = resolveOwnerEntityIdOrDefault(runtime as never);

function seed() {
  const row = {
    id: "review",
    state: "pending",
    requestedBy: "agent",
    subjectUserId: owner,
    action: "schedule_event",
    payload: { calendarId: "primary", title: "QA event" },
    channel: "internal",
    reason: "Create QA event",
    expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
  };
  s.rows.set(row.id, row);
  return approvalRevision(row as never);
}

async function post(body: Record<string, unknown>, id = "review") {
  const out: { status: number; body: unknown } = { status: 0, body: null };
  const helpers = {
    readJsonBody: async () => body,
    json: (_res: unknown, data: unknown, status = 200) => {
      out.status = status;
      out.body = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      out.status = status;
      out.body = { error: message };
    },
  };
  await handleApprovalRoute(
    {} as http.IncomingMessage,
    {} as http.ServerResponse,
    `/api/approvals/${id}/resolve`,
    "POST",
    { runtime },
    helpers as never,
  );
  return out;
}

beforeEach(() => {
  s.rows.clear();
  vi.clearAllMocks();
  s.execute.mockResolvedValue({ kind: "succeeded" });
});

it("executes an approval at the reviewed revision once", async () => {
  const revision = seed();
  expect(await post({ decision: "approve", revision })).toEqual({
    status: 200,
    body: { requestId: "review", decision: "approve", kind: "succeeded" },
  });
  expect(s.execute).toHaveBeenCalledTimes(1);
  expect(s.execute.mock.calls[0][0].request).toMatchObject({
    id: "review",
    state: "approved",
  });
});

it("refuses a stale revision without executing", async () => {
  const revision = seed();
  s.rows.set("review", {
    ...s.rows.get("review"),
    payload: { calendarId: "primary", title: "Changed" },
  });
  expect((await post({ decision: "approve", revision })).status).toBe(409);
  expect(s.rows.get("review")?.state).toBe("pending");
  expect(s.execute).not.toHaveBeenCalled();
});

it("refuses a second approval of the same review", async () => {
  const revision = seed();
  await post({ decision: "approve", revision });
  expect((await post({ decision: "approve", revision })).status).toBe(409);
  expect(s.execute).toHaveBeenCalledTimes(1);
});

it("rejects at the reviewed revision without executing", async () => {
  const revision = seed();
  expect((await post({ decision: "reject", revision })).body).toMatchObject({
    kind: "rejected",
  });
  expect(s.rows.get("review")?.state).toBe("rejected");
  expect(s.execute).not.toHaveBeenCalled();
});

it("requires a decision and the reviewed revision", async () => {
  seed();
  expect((await post({ decision: "approve" })).status).toBe(400);
  expect((await post({ decision: "yes", revision: "x" })).status).toBe(400);
  expect(s.execute).not.toHaveBeenCalled();
});

it("does not resolve another subject's approval", async () => {
  const revision = seed();
  s.rows.set("review", { ...s.rows.get("review"), subjectUserId: "someone" });
  expect((await post({ decision: "approve", revision })).status).toBe(404);
  expect(s.execute).not.toHaveBeenCalled();
});
