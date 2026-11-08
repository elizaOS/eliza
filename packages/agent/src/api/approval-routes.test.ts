import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  execute: vi.fn(),
}));
vi.mock("@elizaos/plugin-assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-assistant")>()),
  createApprovalQueue: () => ({
    byId: async (id: string, subject: string) =>
      s.row && s.row.id === id && s.row.subjectUserId === subject
        ? { ...s.row }
        : null,
    approve: async (id: string) => {
      if (!s.row || s.row.id !== id || s.row.state !== "pending")
        throw Object.assign(new Error("lost race"), {
          name: "ApprovalStateTransitionError",
        });
      s.row = { ...s.row, state: "approved", updatedAt: new Date() };
      return { ...s.row };
    },
    reject: async (id: string) => {
      s.row = { ...s.row, id, state: "rejected", updatedAt: new Date() };
      return { ...s.row };
    },
  }),
}));
vi.mock(
  "../../../../plugins/plugin-calendar/src/mutations/execution.ts",
  () => ({ executeCalendarMutationApproval: s.execute }),
);

import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { calendarApprovalRevision } from "@elizaos/plugin-calendar/mutations/resolve";
import { handleApprovalRoute } from "./approval-routes.ts";

const port = { preflight() {}, execute() {} };
const runtime = {
  agentId: "00000000-0000-0000-0000-000000000001" as const,
  getSetting: () => null,
  getService: (type: string) =>
    type === "calendar_mutation_port" ? port : null,
};
const OWNER = resolveOwnerEntityIdOrDefault(runtime);
const pendingRow = () => ({
  id: "review",
  subjectUserId: OWNER,
  state: "pending",
  action: "schedule_event",
  payload: { calendarId: "primary", title: "QA" },
  reason: "Schedule QA",
  expiresAt: new Date("2026-11-09T00:00:00.000Z"),
  updatedAt: new Date("2026-11-08T00:00:00.000Z"),
});

async function post(
  body: Record<string, unknown>,
  role: string | null = "OWNER",
) {
  const sent: { status: number; data: unknown } = { status: 200, data: null };
  const helpers = {
    json: (_res: unknown, data: unknown, status = 200) => {
      sent.status = status;
      sent.data = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      sent.status = status;
      sent.data = { error: message };
    },
    readJsonBody: async () => body,
  };
  await handleApprovalRoute(
    { url: "/api/approvals/review/resolve" } as http.IncomingMessage,
    {} as http.ServerResponse,
    "/api/approvals/review/resolve",
    "POST",
    {
      runtime,
      callerAuthorization: role ? { ok: true, role } : undefined,
    },
    helpers as never,
  );
  return sent;
}

describe("POST /api/approvals/:id/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s.row = pendingRow();
    s.execute.mockResolvedValue({ kind: "succeeded" });
  });

  it("approves the reviewed revision and executes once", async () => {
    const revision = calendarApprovalRevision(pendingRow() as never);
    const first = await post({ decision: "approve", revision });
    expect(first.status).toBe(200);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.row?.state).toBe("approved");

    const second = await post({ decision: "approve", revision });
    expect(second.status).toBe(409);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale revision without executing", async () => {
    const revision = calendarApprovalRevision({
      ...pendingRow(),
      payload: { calendarId: "primary", title: "Before edit" },
    } as never);
    const sent = await post({ decision: "approve", revision });
    expect(sent.status).toBe(409);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.row?.state).toBe("pending");
  });

  it("refuses a caller that is not the owner", async () => {
    const revision = calendarApprovalRevision(pendingRow() as never);
    expect((await post({ decision: "approve", revision }, "USER")).status).toBe(
      401,
    );
    expect((await post({ decision: "approve", revision }, null)).status).toBe(
      401,
    );
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.row?.state).toBe("pending");
  });

  it("declines the reviewed revision without executing", async () => {
    const revision = calendarApprovalRevision(pendingRow() as never);
    const sent = await post({ decision: "reject", revision });
    expect(sent.status).toBe(200);
    expect(s.row?.state).toBe("rejected");
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("requires a decision and revision", async () => {
    expect((await post({ decision: "approve" })).status).toBe(400);
    expect((await post({ decision: "yes", revision: "x" })).status).toBe(400);
  });
});
