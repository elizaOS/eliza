import type http from "node:http";
import type { PendingUserAction } from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { APPROVAL_SERVICE } from "../services/approval/service.ts";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../services/approval/types.ts";
import { PENDING_PROMPTS_SERVICE } from "../services/pending-prompts/service.ts";
import { handleApprovalRoute } from "./approval-routes.ts";

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

function runtimeWithApprovals(args: {
  queueApprovals?: ApprovalRequest[];
  taskActions?: PendingUserAction[];
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
            listPendingUserActions: () => args.taskActions ?? [],
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
    const taskAction: PendingUserAction = {
      id: "task-approval-1",
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
    const { runtime, queueList } = runtimeWithApprovals({
      queueApprovals: [approval()],
      taskActions: [taskAction],
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
      pendingUserActions: PendingUserAction[];
    };
    expect(payload.approvals).toEqual([
      expect.objectContaining({
        id: "approval-1",
        createdAt: "2026-06-24T18:00:00.000Z",
      }),
    ]);
    expect(payload.pendingUserActions).toEqual([
      expect.objectContaining({
        id: "approval-1",
        kind: "approval",
        title: "Send this reply?",
        resolution: {
          target: "approval_service",
          requestId: "approval-1",
        },
      }),
      taskAction,
      promptAction,
    ]);
  });

  it("GET serves empty arrays when approval services are absent", async () => {
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
      pendingUserActions: [],
    });
  });
});
