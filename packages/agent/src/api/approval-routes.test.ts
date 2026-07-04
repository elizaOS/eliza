/**
 * Unit tests for the `/api/approvals` GET handler and the
 * `approvalTaskToPendingAction` projection: pending user actions are merged
 * newest-first and de-duplicated across the approval queue, the ApprovalService
 * task rows, and the pending-prompts service, and missing services yield empty
 * arrays. Runs against a mock runtime and a real ApprovalService backed by an
 * in-memory task store — no live model or HTTP.
 */
import type http from "node:http";
import type { PendingUserAction, Task, UUID } from "@elizaos/core";
import { ApprovalService, ServiceType } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
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

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
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

async function makeRuntimeWithApprovalService(tasks: Task[]): Promise<{
  runtime: { getService: (type: string) => unknown };
}> {
  const baseRuntime = createMockRuntime({
    agentId: AGENT_ID,
    getTasks: vi.fn(
      async (params: {
        tags?: string[];
        agentIds: UUID[];
      }): Promise<Task[]> => {
        if (!params.agentIds.includes(AGENT_ID)) return [];
        const wanted = new Set(params.tags ?? []);
        return tasks.filter((task) =>
          [...wanted].every((tag) => task.tags?.includes(tag)),
        );
      },
    ),
  });
  const service = (await ApprovalService.start(baseRuntime)) as ApprovalService;
  return {
    runtime: {
      getService: (type: string) =>
        type === ServiceType.APPROVAL ? service : null,
    },
  };
}

function runtimeWithApprovals(args: {
  queueApprovals?: ApprovalRequest[];
  serviceActions?: PendingUserAction[];
  taskRows?: Task[];
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
            getAllPendingApprovals: () => args.taskRows ?? [],
            listPendingUserActions: () => args.serviceActions ?? [],
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
    expect(action).toMatchObject({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      kind: "task_approval",
      source: "approval-service",
      title: "Post this tweet?",
      createdAt: 4_242,
      options: [
        { id: "approve", label: "Approve the request" },
        { id: "deny", label: "Deny", isCancel: true },
      ],
    });
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

  it("GET returns approval rows plus canonical pending user actions", async () => {
    const serviceAction: PendingUserAction = {
      id: "service-approval-1",
      kind: "task_approval",
      source: "approval-service",
      title: "Allow shell command?",
      createdAt: Date.parse("2026-06-24T18:02:00.000Z"),
    };
    const promptAction: PendingUserAction = {
      id: "prompt-1",
      kind: "pending_prompt",
      source: "pending-prompts",
      title: "Did you take meds?",
      expectedReplyKind: "yes_no",
      createdAt: Date.parse("2026-06-24T18:03:00.000Z"),
    };
    const taskRow = approvalTask({
      id: "aaaaaaaa-0000-0000-0000-000000000004",
      description: "Task-row approval",
      createdAt: Date.parse("2026-06-24T18:04:00.000Z"),
    });
    const { runtime, queueList } = runtimeWithApprovals({
      queueApprovals: [approval()],
      serviceActions: [serviceAction],
      taskRows: [taskRow],
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
    expect(payload.pending.map((action) => action.title)).toEqual([
      "Task-row approval",
      "Did you take meds?",
      "Allow shell command?",
      "Send this reply?",
    ]);
    expect(payload.pendingUserActions).toBe(payload.pending);
  });

  it("reads task-store approvals newest-first through ApprovalService", async () => {
    const { runtime } = await makeRuntimeWithApprovalService([
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000010",
        description: "Older request",
        createdAt: 1_000,
      }),
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000011",
        description: "Newer request",
        createdAt: 5_000,
        metadata: { approvalRequest: { createdAt: 5_000 } },
      }),
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000012",
        description: "unrelated",
        tags: ["SOME_OTHER_TAG"],
      }),
    ]);
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
    expect(payload.pending.map((action) => action.title)).toEqual([
      "Newer request",
      "Older request",
    ]);
  });

  it("deduplicates pending actions by id", async () => {
    const duplicate: PendingUserAction = {
      id: "same",
      kind: "task_approval",
      source: "approval-service",
      title: "Service wins",
      createdAt: 2,
    };
    const { runtime } = runtimeWithApprovals({
      serviceActions: [duplicate],
      promptActions: [
        { ...duplicate, title: "Duplicate prompt", createdAt: 3 },
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
