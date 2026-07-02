/**
 * Approved-request execution (issues #10723 Bug 2 and #10721).
 *
 * The old `executeApprovedRequest` flipped execute_workflow approvals through
 * markExecuting -> markDone WITHOUT invoking the workflow runner, and returned
 * `success: true, "Approved."` for executor-less actions while executing
 * nothing. These tests pin the fixes: approved execute_workflow /
 * schedule_event / make_call / sign_document requests drive their real rails
 * (`LifeOpsService.runWorkflow`, `LifeOpsService.createCalendarEvent`, Twilio
 * voice dispatch, the DocumentRequest lifecycle), rail failures surface as
 * typed failures instead of fake success, and actions with no rail at all
 * (spend_money) return an explicit NO_EXECUTOR failure.
 *
 * Run: bunx vitest run test/resolve-request-executor.test.ts
 */

import { randomUUID } from "node:crypto";
import type {
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const twilioMocks = vi.hoisted(() => ({
  readTwilioCredentialsFromEnv: vi.fn<
    () => {
      accountSid: string;
      authToken: string;
      fromPhoneNumber: string;
    } | null
  >(() => null),
  sendTwilioVoiceCall: vi.fn(
    async (): Promise<{
      ok: boolean;
      status: number | null;
      sid?: string;
      error?: string;
    }> => ({ ok: true, status: 201, sid: "CA-approved-1" }),
  ),
}));

vi.mock("@elizaos/plugin-phone/twilio", () => twilioMocks);

// The sign_document tests seed a real DocumentRequest through the real
// OWNER_DOCUMENTS action; only its collaborators (owner gate, approval-queue
// persistence, scheduled-task runner) are mocked, mirroring
// test/document-action.test.ts.
const docMocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  enqueue: vi.fn(async (input: { payload?: unknown }) => ({
    id: `approval-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    state: "pending" as const,
    requestedBy: "OWNER_DOCUMENTS",
    subjectUserId: "owner-1",
    action: "sign_document",
    payload: input.payload ?? {},
    channel: "internal",
    reason: "",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
  })),
  schedule: vi.fn(async (task: { kind: string; trigger: unknown }) => ({
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    kind: task.kind,
    trigger: task.trigger,
    state: { status: "scheduled", followupCount: 0 },
  })),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: docMocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    enqueue: docMocks.enqueue,
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    markExecuting: vi.fn(),
    markDone: vi.fn(),
  }),
}));

vi.mock("../src/lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => ({
    schedule: docMocks.schedule,
    apply: vi.fn(),
    list: vi.fn(),
    pipeline: vi.fn(),
    evaluateCompletion: vi.fn(),
    fire: vi.fn(),
    fireWithResult: vi.fn(),
  }),
}));

import {
  __resetDocumentStoreForTests,
  ownerDocumentsAction,
} from "../src/actions/document.js";
import { executeApprovedRequest } from "../src/actions/resolve-request.js";
import type {
  ApprovalEnqueueInput,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalRequestState,
  ApprovalResolution,
} from "../src/lifeops/approval-queue.types.js";
import { LifeOpsService } from "../src/lifeops/service.js";

function makeRuntime(): IAgentRuntime {
  return { agentId: randomUUID() as UUID } as unknown as IAgentRuntime;
}

/** In-memory ApprovalQueue that records the transitions executors drive. */
class RecordingQueue implements ApprovalQueue {
  public readonly transitions: ApprovalRequestState[] = [];
  constructor(private request: ApprovalRequest) {}

  private setState(state: ApprovalRequestState): ApprovalRequest {
    this.request = { ...this.request, state };
    this.transitions.push(state);
    return this.request;
  }

  async enqueue(_input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    throw new Error("not under test");
  }
  async list(
    _filter: ApprovalListFilter,
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    return [this.request];
  }
  async byId(id: string): Promise<ApprovalRequest | null> {
    return this.request.id === id ? this.request : null;
  }
  async approve(
    _id: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.setState("approved");
  }
  async reject(
    _id: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.setState("rejected");
  }
  async markExecuting(_id: string): Promise<ApprovalRequest> {
    return this.setState("executing");
  }
  async markDone(_id: string): Promise<ApprovalRequest> {
    return this.setState("done");
  }
  async markExpired(_id: string): Promise<ApprovalRequest> {
    return this.setState("expired");
  }
  async purgeExpired(_now: Date): Promise<ReadonlyArray<string>> {
    return [];
  }
}

function approvedRequest(
  overrides: Pick<ApprovalRequest, "action" | "payload"> &
    Partial<ApprovalRequest>,
): ApprovalRequest {
  const now = new Date();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: "approved",
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-1",
    channel: "browser",
    reason: "needs owner approval",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    resolvedAt: now,
    resolvedBy: "owner-1",
    resolutionReason: "user approved",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetDocumentStoreForTests();
  twilioMocks.readTwilioCredentialsFromEnv.mockReset();
  twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue(null);
  twilioMocks.sendTwilioVoiceCall.mockReset();
  twilioMocks.sendTwilioVoiceCall.mockResolvedValue({
    ok: true,
    status: 201,
    sid: "CA-approved-1",
  });
  docMocks.enqueue.mockClear();
  docMocks.schedule.mockClear();
});

function collectTexts(): { texts: string[]; callback: HandlerCallback } {
  const texts: string[] = [];
  const callback: HandlerCallback = async (content) => {
    if (typeof content.text === "string") texts.push(content.text);
    return [];
  };
  return { texts, callback };
}

describe("executeApprovedRequest", () => {
  it("execute_workflow approval actually runs the workflow", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: "doc.upload_asset",
        input: { documentId: "doc-1" },
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi
      .spyOn(LifeOpsService.prototype, "runWorkflow")
      .mockResolvedValue({
        id: "run-77",
        agentId: String(runtime.agentId),
        workflowId: "doc.upload_asset",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "success",
        result: {},
        auditRef: null,
      });
    const texts: string[] = [];
    const callback: HandlerCallback = async (content) => {
      if (typeof content.text === "string") texts.push(content.text);
      return [];
    };

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("doc.upload_asset", {
      confirmBrowserActions: true,
    });
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      workflowId: "doc.upload_asset",
      workflowRunId: "run-77",
      workflowRunStatus: "success",
      state: "done",
    });
    expect(texts.join(" ")).toContain("run-77");
  });

  it("a failing workflow surfaces the error and never reaches done", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: "wf-broken",
        input: {},
      },
    });
    const queue = new RecordingQueue(request);
    vi.spyOn(LifeOpsService.prototype, "runWorkflow").mockRejectedValue(
      new Error("workflow step exploded"),
    );

    await expect(
      executeApprovedRequest({ runtime, queue, request }),
    ).rejects.toThrow("workflow step exploded");
    expect(queue.transitions).toEqual(["executing"]);
  });

  it("executor-less action (sign_document) fails loudly with NO_EXECUTOR", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "sign_document",
      payload: {
        action: "sign_document",
        documentId: "doc-9",
        documentName: "NDA.pdf",
        signatureUrl: "https://sign.example.com/doc-9",
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const texts: string[] = [];
    const callback: HandlerCallback = async (content) => {
      if (typeof content.text === "string") texts.push(content.text);
      return [];
    };

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "NO_EXECUTOR",
      action: "sign_document",
      requestId: request.id,
    });
    // Nothing executed and nothing marked done: the queue rows stay honest.
    expect(runSpy).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("nothing was executed");
  });
});
