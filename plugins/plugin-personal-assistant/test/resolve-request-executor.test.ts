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
import { parseInteractionBlocks } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
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
  list: vi.fn(async (): Promise<unknown[]> => []),
  approve: vi.fn(),
  reject: vi.fn(),
  markExecuting: vi.fn(),
  markDone: vi.fn(),
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
    list: docMocks.list,
    approve: docMocks.approve,
    reject: docMocks.reject,
    markExecuting: docMocks.markExecuting,
    markDone: docMocks.markDone,
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
import {
  buildResolveRequestChoice,
  executeApprovedRequest,
  resolveRequestAction,
} from "../src/actions/resolve-request.js";
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

function fakeCalendarEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "cal-evt-1",
    externalId: "ext-cal-evt-1",
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Board sync",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-07-02T17:00:00.000Z",
    endAt: "2026-07-02T18:00:00.000Z",
    isAllDay: false,
    timezone: null,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  docMocks.list.mockReset();
  docMocks.list.mockResolvedValue([]);
  docMocks.approve.mockReset();
  docMocks.reject.mockReset();
  docMocks.markExecuting.mockReset();
  docMocks.markDone.mockReset();
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
    const { texts, callback } = collectTexts();

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

  it("schedule_event approval creates the calendar event through LifeOpsService", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "schedule_event",
      payload: {
        action: "schedule_event",
        calendarId: "primary",
        title: "Board sync",
        startsAtMs: Date.parse("2026-07-02T17:00:00.000Z"),
        endsAtMs: Date.parse("2026-07-02T18:00:00.000Z"),
        attendees: ["ada@example.com", "grace@example.com"],
        location: "Zoom",
        description: "Q3 planning",
      },
    });
    const queue = new RecordingQueue(request);
    const createSpy = vi
      .spyOn(LifeOpsService.prototype, "createCalendarEvent")
      .mockResolvedValue(fakeCalendarEvent());
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[1]).toEqual({
      calendarId: "primary",
      title: "Board sync",
      startAt: "2026-07-02T17:00:00.000Z",
      endAt: "2026-07-02T18:00:00.000Z",
      location: "Zoom",
      description: "Q3 planning",
      attendees: [{ email: "ada@example.com" }, { email: "grace@example.com" }],
    });
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      calendarEventId: "cal-evt-1",
      calendarId: "primary",
      state: "done",
    });
    expect(texts.join(" ")).toContain("Board sync");
  });

  it("a failing calendar rail (e.g. calendar not connected) propagates and never reaches done", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "schedule_event",
      payload: {
        action: "schedule_event",
        calendarId: "",
        title: "Board sync",
        startsAtMs: Date.parse("2026-07-02T17:00:00.000Z"),
        endsAtMs: Date.parse("2026-07-02T18:00:00.000Z"),
        attendees: [],
        location: null,
        description: null,
      },
    });
    const queue = new RecordingQueue(request);
    vi.spyOn(LifeOpsService.prototype, "createCalendarEvent").mockRejectedValue(
      new Error("Google Calendar is not connected"),
    );

    await expect(
      executeApprovedRequest({ runtime, queue, request }),
    ).rejects.toThrow("Google Calendar is not connected");
    expect(queue.transitions).toEqual(["executing"]);
  });

  it("make_call approval without Twilio credentials fails honestly and stays retriable", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "TWILIO_NOT_CONFIGURED",
      action: "make_call",
      requestId: request.id,
    });
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    // The request never left `approved`: the owner can retry after
    // configuring Twilio.
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("not placed");
  });

  it("a failed Twilio dispatch surfaces a typed failure and never reaches done", async () => {
    const runtime = makeRuntime();
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue({
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    });
    twilioMocks.sendTwilioVoiceCall.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Authenticate",
    });
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "TWILIO_DELIVERY_FAILED",
      detail: "Authenticate",
      status: 401,
    });
    expect(queue.transitions).toEqual(["executing"]);
    expect(texts.join(" ")).toContain("not placed");
  });

  it("make_call approval places the call through the Twilio rail", async () => {
    const runtime = makeRuntime();
    const credentials = {
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    };
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue(credentials);
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(twilioMocks.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
    expect(twilioMocks.sendTwilioVoiceCall).toHaveBeenCalledWith({
      credentials,
      to: "+15550100",
      message: "Confirming tomorrow's appointment.",
    });
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      callSid: "CA-approved-1",
      state: "done",
    });
    expect(texts.join(" ")).toContain("+15550100");
  });

  it("sign_document approval dispatches the real DocumentRequest seeded through OWNER_DOCUMENTS", async () => {
    const runtime = makeRuntime();
    const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const seeded = await ownerDocumentsAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "get the NDA signed" },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "request_signature",
          requesteeEntityId: "entity-alice-001",
          documentTitle: "Partnership NDA",
          deadline,
          signatureUrl: "https://sign.example.com/nda",
        },
      } as unknown as HandlerOptions,
      async () => [],
    );
    expect(seeded).toMatchObject({ success: true });
    // The payload the document action actually enqueued for owner approval.
    const enqueued = docMocks.enqueue.mock.calls[0]?.[0];
    if (!enqueued) throw new Error("request_signature enqueued no approval");
    const payload = enqueued.payload as ApprovalRequest["payload"];
    expect(payload).toMatchObject({
      action: "sign_document",
      documentName: "Partnership NDA",
    });

    const request = approvedRequest({ action: "sign_document", payload });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(true);
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.data).toMatchObject({
      documentStatus: "in_progress",
      state: "done",
    });
    expect(texts.join(" ")).toContain("Partnership NDA");
  });

  it("sign_document approval for a vanished DocumentRequest fails honestly and dispatches nothing", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "sign_document",
      payload: {
        action: "sign_document",
        documentId: "doc-gone",
        documentName: "NDA.pdf",
        signatureUrl: "https://sign.example.com/doc-gone",
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "DOCUMENT_REQUEST_NOT_FOUND",
      action: "sign_document",
      documentId: "doc-gone",
    });
    expect(queue.transitions).toEqual(["executing"]);
    expect(texts.join(" ")).toContain("re-issue");
  });

  it("executor-less action (spend_money) fails loudly with NO_EXECUTOR", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "spend_money",
      payload: {
        action: "spend_money",
        vendor: "AWS",
        amountCents: 12_000,
        currency: "USD",
        memo: "renew reserved instances",
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const calendarSpy = vi.spyOn(
      LifeOpsService.prototype,
      "createCalendarEvent",
    );
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "NO_EXECUTOR",
      action: "spend_money",
      requestId: request.id,
    });
    // Nothing executed and nothing marked done: the queue rows stay honest.
    expect(runSpy).not.toHaveBeenCalled();
    expect(calendarSpy).not.toHaveBeenCalled();
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("nothing was executed");
  });
});

describe("RESOLVE_REQUEST reject path", () => {
  it("rejecting a make_call request executes no rail and flips the row to rejected", async () => {
    const runtime = makeRuntime();
    const pending = approvedRequest({
      action: "make_call",
      state: "pending",
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue({
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    });
    docMocks.list.mockResolvedValue([pending]);
    docMocks.reject.mockResolvedValue({ ...pending, state: "rejected" });
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "no, don't place that call" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "reject",
          requestId: pending.id,
          reason: "not now",
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(docMocks.reject).toHaveBeenCalledTimes(1);
    expect(docMocks.reject).toHaveBeenCalledWith(pending.id, {
      resolvedBy: "owner-1",
      resolutionReason: "not now",
    });
    // Rejection touches no rail and no executing/done transition.
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    expect(docMocks.markExecuting).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
    expect(texts.join(" ")).toContain("Rejected");
  });
});

describe("RESOLVE_REQUEST ambiguous-target chips (#14733)", () => {
  function pendingPair(): [ApprovalRequest, ApprovalRequest] {
    const base = {
      state: "pending" as const,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    };
    return [
      approvedRequest({
        ...base,
        action: "send_email",
        reason: "Send the quarterly report to Dana",
        payload: {
          action: "send_email",
          to: ["dana@example.com"],
          cc: [],
          bcc: [],
          subject: "Q2 report",
          body: "Attached.",
          replyToMessageId: null,
        },
      }),
      approvedRequest({
        ...base,
        action: "send_message",
        reason: "Text JJ that the demo moved to 3pm",
        payload: {
          action: "send_message",
          recipient: "+15550100",
          body: "Demo moved to 3pm",
          replyToMessageId: null,
        },
      }),
    ];
  }

  it("asks 'Which request?' with one chip per pending row, values carrying `<intent> <requestId>`", async () => {
    const runtime = makeRuntime();
    const [first, second] = pendingPair();
    docMocks.list.mockResolvedValue([first, second]);
    const { texts, callback } = collectTexts();

    // No requestId and no useModel on the runtime: extraction cannot pick a
    // row, which is exactly the ambiguous branch under test.
    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "approve it" },
      } as Memory,
      undefined,
      {
        parameters: { action: "approve" },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({ success: false });
    expect(texts).toHaveLength(1);
    const reply = texts[0] ?? "";
    expect(reply).toContain("Which request?");
    const { blocks } = parseInteractionBlocks(reply);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "choice") throw new Error("expected choice block");
    expect(block.scope).toBe("approval-resolve");
    expect(block.options.map((o) => o.value)).toEqual([
      `approve ${first.id}`,
      `approve ${second.id}`,
    ]);
    // Labels are the human-authored reasons, so the chips read as decisions.
    expect(block.options[0]?.label).toContain("quarterly report");
    expect(block.options[1]?.label).toContain("demo moved to 3pm");
  });

  it("a tapped chip value round-trips: `reject <id>` resolves exactly that row", async () => {
    const runtime = makeRuntime();
    const [first, second] = pendingPair();
    docMocks.list.mockResolvedValue([first, second]);
    docMocks.reject.mockResolvedValue({ ...second, state: "rejected" });

    // Build the chips for a reject intent and simulate the tap: the value is
    // the user's next message and the extraction reads the id verbatim.
    const chips = buildResolveRequestChoice("reject", [first, second]);
    const tapped = chips.options[1]?.value ?? "";
    expect(tapped).toBe(`reject ${second.id}`);
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: tapped },
      } as Memory,
      undefined,
      {
        parameters: { action: "reject", requestId: second.id },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({ success: true });
    expect(docMocks.reject).toHaveBeenCalledTimes(1);
    expect(docMocks.reject.mock.calls[0]?.[0]).toBe(second.id);
    expect(texts.join(" ")).toContain("Rejected");
  });
});
