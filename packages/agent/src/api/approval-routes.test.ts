import type http from "node:http";
import type { PendingUserAction, Task, UUID } from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { APPROVAL_SERVICE } from "../services/approval/service.ts";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../services/approval/types.ts";
import { PENDING_PROMPTS_SERVICE } from "../services/pending-prompts/service.ts";
import {
  approvalTaskToPendingAction,
  handleApprovalRoute,
} from "./approval-routes.ts";

const req = (url: string) => ({ url }) as http.IncomingMessage;
const res = {} as http.ServerResponse;

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    state: "pending",
    requestedBy: "agent",
    subjectUserId: "owner",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "alice",
      body: "hello",
      replyToMessageId: null,
    },
    channel: "discord",
    reason: "Send this reply?",
    expiresAt: new Date("2026-06-24T19:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    createdAt: new Date("2026-06-24T18:00:00.000Z"),
    updatedAt: new Date("2026-06-24T18:01:00.000Z"),
    ...overrides,
  };
}

function approvalTask(patch: Partial<Task> & { id: string }): Task {
  return {
    id: patch.id as UUID,
    name: patch.name ?? "EXEC_APPROVAL",
    description: patch.description ?? "Run rm -rf /tmp/cache?",
    roomId: (patch.roomId ?? "11111111-1111-1111-1111-111111111111") as UUID,
    tags: patch.tags ?? ["AWAITING_CHOICE", "APPROVAL"],
    createdAt: patch.createdAt ?? 1_000,
    metadata: patch.metadata,
  };
}

function runtimeWithApprovals(args: {
  queueApprovals?: ApprovalRequest[];
  serviceActions?: PendingUserAction[];
  taskApprovals?: Task[];
  promptActions?: PendingUserAction[];
}) {
  const queueList = vi.fn(async () => args.queueApprovals ?? []);
  const queue = { list: queueList } as unknown as ApprovalQueue;
  return {
    runtime: {
      agentId: "agent-1",
      getService: (type: string) => {
        if (type === APPROVAL_SERVICE) return { getQueue: () => queue };
        if (type === ServiceType.APPROVAL) {
          return {
            listPendingUserActions: () => args.serviceActions ?? [],
            getAllPendingApprovals: async () => args.taskApprovals ?? [],
          };
        }
        if (type === PENDING_PROMPTS_SERVICE) {
          return {
            listPendingUserActions: async () => args.promptActions ?? [],
          };
        }
        return null;
      },
    },
    queueList,
  };
}

describe("approvalTaskToPendingAction", () => {
  it("projects a task into a PendingUserAction with options and createdAt", () => {
    const action = approvalTaskToPendingAction(
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        description: "Post this tweet?",
        metadata: {
          options: [
            { name: "approve", description: "Approve the request" },
            { name: "deny", description: "Deny", isCancel: true },
          ],
          approvalRequest: { createdAt: 4_242 },
        },
      }),
    );
    expect(action).not.toBeNull();
    expect(action?.kind).toBe("task_approval");
    expect(action?.source).toBe("approval-service");
    expect(action?.title).toBe("Post this tweet?");
    expect(action?.createdAt).toBe(4_242);
    expect(action?.resolution).toEqual({
      target: "approval_service",
      requestId: "aaaaaaaa-0000-0000-0000-000000000001",
    });
    expect(action?.options).toEqual([
      { id: "approve", label: "Approve the request" },
      { id: "deny", label: "Deny", isCancel: true },
    ]);
  });

  it("drops a malformed task missing id or roomId", () => {
    expect(
      approvalTaskToPendingAction({
        name: "X",
        tags: ["APPROVAL"],
      } as Task),
    ).toBeNull();
  });

  it("falls back to the row createdAt and task name when metadata is absent", () => {
    const action = approvalTaskToPendingAction(
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        name: "CONFIRM_123",
        description: "   ",
        createdAt: 999,
      }),
    );
    expect(action?.createdAt).toBe(999);
    expect(action?.title).toBe("CONFIRM_123");
    expect(action?.options).toBeUndefined();
  });
});

describe("handleApprovalRoute", () => {
  it("ignores non-approval paths", async () => {
    const helpers = makeHelpers();
    const handled = await handleApprovalRoute(
      req("/api/other"),
      res,
      "/api/other",
      "GET",
      { runtime: null },
      helpers,
    );
    expect(handled).toBe(false);
  });

  it("GET aggregates approval rows, task approvals, and prompts newest-first", async () => {
    const serviceAction: PendingUserAction = {
      id: "task-approval-1",
      kind: "task_approval",
      source: "approval-service",
      title: "Allow shell command?",
      createdAt: Date.parse("2026-06-24T18:04:00.000Z"),
    };
    const promptAction: PendingUserAction = {
      id: "prompt-1",
      kind: "pending_prompt",
      source: "pending-prompts",
      title: "Did you take meds?",
      expectedReplyKind: "yes_no",
      createdAt: Date.parse("2026-06-24T18:03:00.000Z"),
    };
    const { runtime, queueList } = runtimeWithApprovals({
      queueApprovals: [approval()],
      serviceActions: [serviceAction],
      taskApprovals: [
        approvalTask({
          id: "aaaaaaaa-0000-0000-0000-000000000010",
          description: "Persisted approval",
          createdAt: Date.parse("2026-06-24T18:02:00.000Z"),
        }),
      ],
      promptActions: [promptAction],
    });
    const helpers = makeHelpers();

    await handleApprovalRoute(
      req("/api/approvals?limit=5"),
      res,
      "/api/approvals",
      "GET",
      { runtime },
      helpers,
    );

    expect(queueList).toHaveBeenCalledWith({
      subjectUserId: null,
      state: "pending",
      action: null,
      limit: 5,
    });
    const payload = helpers.json.mock.calls[0][1] as {
      approvals: Array<{ id: string; createdAt: string }>;
      pending: PendingUserAction[];
      pendingUserActions: PendingUserAction[];
    };
    expect(payload.approvals).toEqual([
      expect.objectContaining({
        id: "approval-1",
        createdAt: "2026-06-24T18:00:00.000Z",
      }),
    ]);
    expect(payload.pending.map((action) => action.id)).toEqual([
      "task-approval-1",
      "prompt-1",
      "aaaaaaaa-0000-0000-0000-000000000010",
      "approval-1",
    ]);
    expect(payload.pendingUserActions).toBe(payload.pending);
    expect(payload.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "approval-1",
          kind: "approval",
          title: "Send this reply?",
          resolution: {
            target: "approval_service",
            requestId: "approval-1",
          },
        }),
        promptAction,
      ]),
    );
  });

  it("dedupes actions returned by both live and persisted approval surfaces", async () => {
    const duplicate: PendingUserAction = {
      id: "aaaaaaaa-0000-0000-0000-000000000010",
      kind: "task_approval",
      source: "approval-service",
      title: "Live approval",
      createdAt: 10,
    };
    const { runtime } = runtimeWithApprovals({
      serviceActions: [duplicate],
      taskApprovals: [
        approvalTask({
          id: duplicate.id,
          description: "Persisted approval",
          createdAt: 5,
        }),
      ],
    });
    const helpers = makeHelpers();

    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "GET",
      { runtime },
      helpers,
    );

    const payload = helpers.json.mock.calls[0][1] as {
      pending: PendingUserAction[];
    };
    expect(payload.pending).toEqual([duplicate]);
  });

  it("rejects non-GET methods with 404", async () => {
    const helpers = makeHelpers();
    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "POST",
      { runtime: { getService: () => null } },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 404);
  });

  it("serves empty arrays when approval services are absent", async () => {
    const helpers = makeHelpers();
    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "GET",
      { runtime: { getService: () => null } },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, {
      approvals: [],
      pending: [],
      pendingUserActions: [],
    });
  });
});
