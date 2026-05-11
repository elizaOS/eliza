/**
 * `DOC` umbrella action — unit tests.
 *
 * Wave-1 scaffold (W1-8). Asserts that the action surface advertised in the
 * PRD §Docs And Portals exists and validates inputs correctly. Persistence
 * for `DocumentRequest` is in-memory in Wave-1; these tests pin that
 * behavior so Wave-2 scenarios can build on it.
 */

import type { HandlerOptions, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  enqueue: vi.fn(async (input: unknown) => ({
    id: `approval-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    state: "pending" as const,
    requestedBy:
      (input as { requestedBy?: string }).requestedBy ?? "DOC",
    subjectUserId:
      (input as { subjectUserId?: string }).subjectUserId ?? "owner-1",
    action: (input as { action?: string }).action ?? "sign_document",
    payload: (input as { payload?: unknown }).payload ?? {},
    channel: (input as { channel?: string }).channel ?? "internal",
    reason: (input as { reason?: string }).reason ?? "",
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
  apply: vi.fn(async (taskId: string, verb: string) => ({
    taskId,
    state: { status: verb === "dismiss" ? "dismissed" : "scheduled", followupCount: 0 },
  })),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    enqueue: mocks.enqueue,
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    markExecuting: vi.fn(),
    markDone: vi.fn(),
  }),
}));

vi.mock("../src/lifeops/scheduled-task/runtime-wiring.js", () => ({
  createRuntimeScheduledTaskRunner: () => ({
    schedule: mocks.schedule,
    apply: mocks.apply,
    list: vi.fn(),
    pipeline: vi.fn(),
    evaluateCompletion: vi.fn(),
  }),
}));

import {
  __resetDocumentStoreForTests,
  docAction,
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
  return docAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("DOC umbrella action — Docs And Portals", () => {
  beforeEach(() => {
    __resetDocumentStoreForTests();
    mocks.enqueue.mockClear();
    mocks.schedule.mockClear();
    mocks.apply.mockClear();
  });

  describe("metadata", () => {
    it("exposes the canonical name and PRD similes", () => {
      expect(docAction.name).toBe("DOC");
      const similes = docAction.similes ?? [];
      for (const required of [
        "DOC_REQUEST_SIGNATURE",
        "DOC_REQUEST_APPROVAL",
        "DOC_TRACK_DEADLINE",
        "DOC_UPLOAD_ASSET",
        "DOC_COLLECT_ID_OR_FORM",
        "DOC_CLOSE_REQUEST",
        "DOCUMENT",
        "DOCUMENTS",
        "PAPERWORK",
      ]) {
        expect(similes).toContain(required);
      }
    });

    it("validates as accessible for an owner-attached message", async () => {
      const ok = await docAction.validate?.(makeRuntime(), makeMessage(), undefined);
      expect(ok).toBe(true);
    });

    it("rejects calls with no subaction selector", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("accepts simile-style action names mapped through the subaction map", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        // simile-style: action arg uses the PRD name, handler maps it.
        action: "DOC_REQUEST_APPROVAL",
        documentTitle: "Quarterly Plan",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ subaction: "request_approval" });
    });
  });

  describe("request_signature", () => {
    it("creates a DocumentRequest, enqueues an approval, and schedules a deadline task", async () => {
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
      const docId = (result.data as { documentRequestId: string }).documentRequestId;
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
    it("creates a DocumentRequest with an approval kind", async () => {
      const result = await callDoc(makeRuntime(), makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
        approvalReason: "Need yes/no on the SOW",
      });
      expect(result.success).toBe(true);
      const doc = (result.data as { documentRequest: { kind: string } }).documentRequest;
      expect(doc.kind).toBe("approval");
    });

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
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
      });
      const docId = (created.data as { documentRequestId: string }).documentRequestId;
      mocks.schedule.mockClear();

      const result = await callDoc(runtime, makeMessage(), {
        subaction: "track_deadline",
        documentRequestId: docId,
        deadline: "2026-06-01T17:00:00.000Z",
      });
      expect(result.success).toBe(true);
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      const scheduleArg = mocks.schedule.mock.calls[0][0] as {
        trigger: { atIso: string };
      };
      expect(scheduleArg.trigger.atIso).toBe("2026-06-01T17:00:00.000Z");
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
      expect(result.data).toMatchObject({ error: "DOCUMENT_REQUEST_NOT_FOUND" });
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
      const doc = (result.data as { documentRequest: { kind: string } }).documentRequest;
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
    it("marks the request completed and dismisses the linked SCHEDULED_TASK", async () => {
      const runtime = makeRuntime();
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_signature",
        requesteeEntityId: "entity-alice-001",
        documentTitle: "Partnership NDA",
        deadline: "2026-05-15T17:00:00.000Z",
      });
      const docId = (created.data as { documentRequestId: string }).documentRequestId;
      mocks.apply.mockClear();

      const result = await callDoc(runtime, makeMessage(), {
        subaction: "close_request",
        documentRequestId: docId,
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ status: "completed" });
      expect(mocks.apply).toHaveBeenCalledTimes(1);
      const [, verb] = mocks.apply.mock.calls[0];
      expect(verb).toBe("dismiss");
    });

    it("supports cancelled and expired resolutions", async () => {
      const runtime = makeRuntime();
      const created = await callDoc(runtime, makeMessage(), {
        subaction: "request_approval",
        documentTitle: "Vendor SOW",
      });
      const docId = (created.data as { documentRequestId: string }).documentRequestId;

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
      const docId = (created.data as { documentRequestId: string }).documentRequestId;
      const result = await callDoc(runtime, makeMessage(), {
        subaction: "close_request",
        documentRequestId: docId,
        resolution: "bogus" as unknown as "completed",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "INVALID_RESOLUTION" });
    });
  });
});
