/**
 * Exercises owner document-request creation, deadline tracking and closure with
 * the real action and request store. Approval, scheduling and ledger boundaries
 * are controlled collaborators; this does not prove signing or durable storage.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  enqueue: vi.fn(async (_input: unknown) => ({ id: "approval-document" })),
  listTasks: vi.fn(async (): Promise<unknown[]> => []),
  schedule: vi.fn(async (_task: { kind: string; trigger: unknown }) => ({
    taskId: "document-watcher",
  })),
  upsertCommitmentLedgerRecord: vi.fn(async () => undefined),
  apply: vi.fn(
    async (_taskId: string, _verb: string, _options: unknown) => undefined,
  ),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    enqueue: mocks.enqueue,
  }),
}));

vi.mock("../src/lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => ({
    schedule: mocks.schedule,
    apply: mocks.apply,
    list: mocks.listTasks,
  }),
}));

vi.mock("../src/lifeops/repository.js", () => ({
  LifeOpsRepository: class {
    upsertCommitmentLedgerRecord = mocks.upsertCommitmentLedgerRecord;
  },
}));

import {
  __resetDocumentStoreForTests,
  getDocumentRequest,
  ownerDocumentsAction,
} from "../src/actions/document.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-doc-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    adapter: { db: { execute: vi.fn() } },
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "process the document"): Memory {
  return {
    id: "msg-doc-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-doc-1" as UUID,
    content: { text },
  } as Memory;
}

async function callDoc(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  expect(await ownerDocumentsAction.validate(runtime, message)).toBe(true);
  return ownerDocumentsAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("OWNER_DOCUMENTS umbrella action — Docs And Portals", () => {
  beforeEach(() => {
    __resetDocumentStoreForTests();
    mocks.enqueue.mockClear();
    mocks.schedule.mockClear();
    mocks.upsertCommitmentLedgerRecord.mockClear();
    mocks.apply.mockClear();
    mocks.listTasks.mockClear();
    mocks.listTasks.mockImplementation(async () => []);
  });

  describe("operation selection", () => {
    it("rejects calls with no subaction selector", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("accepts simile-style action names mapped through the subaction map", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        // simile-style: action arg uses the PRD name, handler maps it.
        action: "OWNER_DOCUMENTS_REQUEST_APPROVAL",
        documentTitle: "Quarterly Plan",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "request_approval",
        documentRequest: { kind: "approval", status: "pending" },
      });
    });
  });

  describe("request_signature", () => {
    it("creates a signature request and closes its exact deadline watcher", async () => {
      const runtime = makeRuntime();
      const result = await callDoc(runtime, makeMessage(), {
        subaction: "request_signature",
        requesteeEntityId: "entity-alice-001",
        documentTitle: "Partnership NDA",
        deadline: "2026-05-15T17:00:00.000Z",
        signatureUrl: "https://docusign.example/nda-123",
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "request_signature",
        status: "pending",
      });
      const docId = (result.data as { documentRequestId: string })
        .documentRequestId;
      expect(docId).toMatch(/^doc-/);

      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      const enqueueArg = mocks.enqueue.mock.calls[0][0] as {
        action: string;
        payload: { documentName: string; deadline: string };
      };
      expect(enqueueArg.action).toBe("sign_document");
      expect(enqueueArg.payload.documentName).toBe("Partnership NDA");
      expect(enqueueArg.payload.deadline).toBe("2026-05-15T17:00:00.000Z");

      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      const scheduleArg = mocks.schedule.mock.calls[0][0] as {
        kind: string;
        trigger: { kind: string; atIso: string };
        subject: { kind: string; id: string };
      };
      expect(scheduleArg.kind).toBe("watcher");
      expect(scheduleArg.trigger).toEqual({
        kind: "once",
        atIso: "2026-05-15T17:00:00.000Z",
      });
      expect(scheduleArg.subject).toEqual({ kind: "document", id: docId });
      expect(mocks.upsertCommitmentLedgerRecord).toHaveBeenCalledTimes(1);
      expect(mocks.upsertCommitmentLedgerRecord.mock.calls[0][0]).toMatchObject(
        {
          source: "document",
          sourceKey: docId,
          kind: "commitment",
          summary: "Partnership NDA deadline",
          counterparty: "entity-alice-001",
          dueAt: "2026-05-15T17:00:00.000Z",
          status: "tracked",
        },
      );
      const stored = getDocumentRequest(runtime, docId);
      expect(stored).toMatchObject({
        status: "pending",
        approvalRequestId: "approval-document",
        scheduledTaskId: "document-watcher",
      });
      const closed = await callDoc(runtime, makeMessage(), {
        subaction: "close_request",
        documentRequestId: docId,
      });
      expect(closed).toMatchObject({
        success: true,
        data: { status: "completed" },
      });
      expect(getDocumentRequest(runtime, docId)?.status).toBe("completed");
      expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(
        stored?.scheduledTaskId,
        "dismiss",
        { reason: "document completed" },
      );
    });

    it("returns a clear error when deadline is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "request_signature",
        requesteeEntityId: "entity-alice-001",
        documentTitle: "Partnership NDA",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_DEADLINE" });
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it("returns a clear error when requesteeEntityId is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "request_signature",
        documentTitle: "Partnership NDA",
        deadline: "2026-05-15T17:00:00.000Z",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_REQUESTEEENTITYID" });
    });
  });

  describe("request_approval", () => {
    it("errors when documentTitle is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "request_approval",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_DOCUMENTTITLE" });
    });
  });

  describe("track_deadline", () => {
    it("updates an existing DocumentRequest's deadline and schedules a new watcher", async () => {
      const runtime = makeRuntime();
      const deadline = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
      });
      const docId = (created.data as { documentRequestId: string })
        .documentRequestId;
      mocks.schedule.mockClear();

      const result = await callDoc(runtime, makeMessage(), {
        subaction: "track_deadline",
        documentRequestId: docId,
        deadline,
      });
      expect(result.success).toBe(true);
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      const scheduleArg = mocks.schedule.mock.calls[0][0] as {
        trigger: { atIso: string };
      };
      expect(scheduleArg.trigger.atIso).toBe(deadline);
      expect(getDocumentRequest(runtime, docId)).toMatchObject({
        deadline,
        scheduledTaskId: "document-watcher",
      });
      expect(mocks.upsertCommitmentLedgerRecord).toHaveBeenCalledTimes(1);
      expect(mocks.upsertCommitmentLedgerRecord.mock.calls[0][0]).toMatchObject(
        {
          source: "document",
          sourceKey: docId,
          summary: "Vendor SOW deadline",
          kind: "renewal",
          dueAt: deadline,
          status: "tracked",
        },
      );
    });

    it("errors when documentRequestId is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "track_deadline",
        deadline: "2026-06-01T17:00:00.000Z",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_DOCUMENTREQUESTID" });
    });

    it("errors when the DocumentRequest is unknown", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "track_deadline",
        documentRequestId: "doc-does-not-exist",
        deadline: "2026-06-01T17:00:00.000Z",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "DOCUMENT_REQUEST_NOT_FOUND",
      });
    });
  });

  describe("upload_asset", () => {
    it("queues an approval against the browser channel and returns pending state", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "upload_asset",
        portalUrl: "https://speakers.example.com/breakpoint/upload",
        assetPath: "/tmp/deck.pdf",
        assetKind: "deck",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "upload_asset",
        status: "pending",
      });
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      const arg = mocks.enqueue.mock.calls[0][0] as {
        action: string;
        channel: string;
        payload: { workflowId: string };
      };
      expect(arg.action).toBe("execute_workflow");
      expect(arg.channel).toBe("browser");
      expect(arg.payload.workflowId).toBe("doc.upload_asset");
    });

    it("errors when portalUrl is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "upload_asset",
        assetPath: "/tmp/deck.pdf",
        assetKind: "deck",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_PORTALURL" });
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it("errors when assetPath is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "upload_asset",
        portalUrl: "https://speakers.example.com/breakpoint/upload",
        assetKind: "deck",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_ASSETPATH" });
    });

    it("errors when assetKind is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "upload_asset",
        portalUrl: "https://speakers.example.com/breakpoint/upload",
        assetPath: "/tmp/deck.pdf",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_ASSETKIND" });
    });
  });

  describe("collect_id", () => {
    it("creates a collect_id DocumentRequest", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "collect_id",
        requesteeEntityId: "entity-bob-002",
        assetKind: "passport",
      });
      expect(result.success).toBe(true);
      const doc = (result.data as { documentRequest: { kind: string } })
        .documentRequest;
      expect(doc.kind).toBe("collect_id");
    });

    it("errors when requesteeEntityId is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "collect_id",
        assetKind: "passport",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_REQUESTEEENTITYID" });
    });

    it("errors when assetKind is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "collect_id",
        requesteeEntityId: "entity-bob-002",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_ASSETKIND" });
    });
  });

  describe("close_request", () => {
    it("supports cancelling an approval request", async () => {
      const runtime = makeRuntime();
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
      });
      const docId = (created.data as { documentRequestId: string })
        .documentRequestId;

      const result = await callDoc(runtime, makeMessage(), {
        subaction: "close_request",
        documentRequestId: docId,
        resolution: "cancelled",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ status: "cancelled" });
    });

    it("errors when documentRequestId is missing", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "close_request",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_DOCUMENTREQUESTID" });
    });

    it("errors on an unknown resolution string", async () => {
      const runtime = makeRuntime();
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
      });
      const docId = (created.data as { documentRequestId: string })
        .documentRequestId;
      const result = await callDoc(runtime, makeMessage(), {
        subaction: "close_request",
        documentRequestId: docId,
        resolution: "bogus" as unknown as "completed",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "INVALID_RESOLUTION" });
    });
  });

  describe("guarantee_class (#14864)", () => {
    it("installs an event-triggered standing guarantee for a class", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "guarantee_class",
        obligationClass: "renewal",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "guarantee_class",
        obligationClass: "renewal",
        warnDaysBefore: 60,
      });
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      const scheduled = mocks.schedule.mock.calls[0]?.[0] as {
        trigger: { kind: string; eventKind?: string; filter?: unknown };
        idempotencyKey: string;
        metadata: Record<string, unknown>;
      };
      expect(scheduled.trigger.kind).toBe("event");
      expect(scheduled.trigger.eventKind).toBe("document.obligation.observed");
      expect(scheduled.trigger.filter).toEqual({ obligationKind: "renewal" });
      expect(scheduled.idempotencyKey).toBe("commitment-guarantee:renewal");
      expect(scheduled.metadata).toMatchObject({
        standingGuarantee: true,
        warnDaysBefore: 60,
      });
    });

    it("rejects an unknown obligation class", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "guarantee_class",
        obligationClass: "vibes",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_OBLIGATIONCLASS" });
      expect(mocks.schedule).not.toHaveBeenCalled();
    });

    it("track_deadline under a matching guarantee adds the lead-time warn watcher and fires the obligation event", async () => {
      const emitEvent = vi.fn(async () => undefined);
      const runtime = {
        ...makeRuntime(),
        emitEvent,
      } as unknown as IAgentRuntime;
      mocks.listTasks.mockImplementation(async () => [
        {
          taskId: "guarantee-1",
          kind: "watcher",
          trigger: {
            kind: "event",
            eventKind: "document.obligation.observed",
            filter: { obligationKind: "renewal" },
          },
          metadata: { standingGuarantee: true, warnDaysBefore: 60 },
          state: { status: "scheduled", followupCount: 0 },
        },
      ]);
      const deadline = new Date(
        Date.now() + 120 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor MSA renewal",
      });
      const docId = (created.data as { documentRequestId: string })
        .documentRequestId;
      const result = await callDoc(runtime, makeMessage(), {
        subaction: "track_deadline",
        documentRequestId: docId,
        deadline,
      });
      expect(result.success).toBe(true);

      const scheduledInputs = mocks.schedule.mock.calls.map(
        (call) =>
          call[0] as {
            trigger: { kind: string; atIso?: string };
            idempotencyKey?: string;
          },
      );
      const warn = scheduledInputs.find((input) =>
        input.idempotencyKey?.startsWith("commitment-warn:"),
      );
      expect(warn).toBeDefined();
      expect(warn?.trigger.kind).toBe("once");
      expect(warn?.trigger.atIso).toBe(
        new Date(Date.parse(deadline) - 60 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(emitEvent).toHaveBeenCalledWith(
        "document.obligation.observed",
        expect.objectContaining({ obligationKind: "renewal", deadline }),
      );
    });
  });
});
