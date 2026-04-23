import type { ScenarioContext } from "@elizaos/scenario-schema";
import { createServer } from "node:http";
import { scenario } from "@elizaos/scenario-schema";
import { describe, expect, it } from "vitest";
import { runFinalCheck } from "../final-checks/index.ts";

function ctxWith(partial: Partial<ScenarioContext>): ScenarioContext {
  return {
    actionsCalled: [],
    turns: [],
    approvalRequests: [],
    connectorDispatches: [],
    memoryWrites: [],
    stateTransitions: [],
    artifacts: [],
    ...partial,
  };
}

async function withMockGoogleLedger<T>(
  requests: unknown[],
  run: () => Promise<T>,
): Promise<T> {
  const previousMockBase = process.env.MILADY_MOCK_GOOGLE_BASE;
  const previousAllowRealWrites = process.env.MILADY_ALLOW_REAL_GMAIL_WRITES;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__mock/requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requests }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock ledger server did not bind to a TCP port");
  }
  process.env.MILADY_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}`;
  delete process.env.MILADY_ALLOW_REAL_GMAIL_WRITES;
  try {
    return await run();
  } finally {
    if (previousMockBase === undefined) {
      delete process.env.MILADY_MOCK_GOOGLE_BASE;
    } else {
      process.env.MILADY_MOCK_GOOGLE_BASE = previousMockBase;
    }
    if (previousAllowRealWrites === undefined) {
      delete process.env.MILADY_ALLOW_REAL_GMAIL_WRITES;
    } else {
      process.env.MILADY_ALLOW_REAL_GMAIL_WRITES = previousAllowRealWrites;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("final-checks", () => {
  const runtime = {} as unknown as Parameters<typeof runFinalCheck>[1]["runtime"];

  it("actionCalled passes when action present with success", async () => {
    const ctx = ctxWith({
      actionsCalled: [{ actionName: "REPLY", result: { success: true } }],
    });
    const res = await runFinalCheck(
      { type: "actionCalled", actionName: "REPLY", status: "success", minCount: 1 },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("actionCalled fails when missing", async () => {
    const ctx = ctxWith({
      actionsCalled: [{ actionName: "OTHER" }],
    });
    const res = await runFinalCheck(
      { type: "actionCalled", actionName: "REPLY" },
      { runtime, ctx },
    );
    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/REPLY/);
  });

  it("selectedAction accepts any of a list", async () => {
    const ctx = ctxWith({
      actionsCalled: [{ actionName: "GMAIL_ACTION" }],
    });
    const res = await runFinalCheck(
      { type: "selectedAction", actionName: ["INBOX", "GMAIL_ACTION"] },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("memoryWriteOccurred passes on matching table", async () => {
    const ctx = ctxWith({
      memoryWrites: [{ table: "messages", content: { text: "hi" } }],
    });
    const res = await runFinalCheck(
      { type: "memoryWriteOccurred", table: ["messages", "facts"] },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("approvalRequestExists is skipped when no queue registered", async () => {
    const ctx = ctxWith({});
    // Note: ctxWith always populates approvalRequests; simulate absence:
    delete (ctx as { approvalRequests?: unknown }).approvalRequests;
    const res = await runFinalCheck(
      { type: "approvalRequestExists", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("skipped-dependency-missing");
  });

  it("approvalStateTransition passes when approval moved pending to approved", async () => {
    const ctx = ctxWith({
      stateTransitions: [
        {
          subject: "approval",
          from: "pending",
          to: "approved",
          actionName: "BOOK_TRAVEL",
        },
      ],
    });
    const res = await runFinalCheck(
      {
        type: "approvalStateTransition",
        from: "pending",
        to: "approved",
        actionName: "BOOK_TRAVEL",
      },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("browserTaskCompleted passes when action result marks completion", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "SUBSCRIPTIONS",
          result: {
            success: true,
            data: {
              browserTask: { completed: true },
              cancellation: { status: "completed" },
            },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "browserTaskCompleted", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("browserTaskNeedsHuman passes when cancellation awaits confirmation", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "SUBSCRIPTIONS",
          result: {
            success: true,
            data: {
              browserTask: { needsHuman: true },
              cancellation: { status: "awaiting_confirmation" },
            },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "browserTaskNeedsHuman", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("uploadedAssetExists passes on captured artifacts", async () => {
    const ctx = ctxWith({
      artifacts: [{ source: "result", kind: "screenshot", detail: "x" }],
    });
    const res = await runFinalCheck(
      { type: "uploadedAssetExists", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("draftExists passes on gmailDraft action data", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "GMAIL_ACTION",
          result: {
            success: true,
            data: {
              gmailDraft: { messageId: "msg-1", subject: "Re: brief" },
            },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "draftExists", channel: "gmail", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("draftExists treats x-dm and x_dm as the same channel", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "OWNER_SEND_MESSAGE",
          result: {
            success: true,
            data: {
              channel: "x_dm",
              draft: true,
            },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "draftExists", channel: "x-dm", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("messageDelivered passes on captured connector dispatch", async () => {
    const ctx = ctxWith({
      connectorDispatches: [
        {
          channel: "discord",
          delivered: true,
          sentAt: new Date().toISOString(),
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "messageDelivered", channel: "discord", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("connectorDispatchOccurred passes on delivered cross-channel action fallback", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "OWNER_SEND_MESSAGE",
          result: {
            success: true,
            data: { channel: "sms", status: "sent" },
            text: "Sent sms to +15555550101.",
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "connectorDispatchOccurred", channel: "sms" },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("pushEscalationOrder passes when dispatches follow the expected ladder", async () => {
    const ctx = ctxWith({
      connectorDispatches: [
        { channel: "desktop", delivered: true },
        { channel: "mobile", delivered: true },
      ],
    });
    const res = await runFinalCheck(
      {
        type: "pushEscalationOrder",
        channelOrder: ["desktop", "mobile"],
      },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("pushAcknowledgedSync passes when INTENT_SYNC acknowledged an intent", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "INTENT_SYNC",
          parameters: { subaction: "acknowledge", intentId: "intent-1" },
          result: { success: true, data: { intentId: "intent-1" } },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "pushAcknowledgedSync", expected: true },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("noSideEffectOnReject passes when rejection has no completion or artifacts", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "SUBSCRIPTIONS",
          parameters: { confirmed: false },
          result: {
            success: true,
            data: { cancellation: { status: "awaiting_confirmation" } },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      { type: "noSideEffectOnReject", actionName: "SUBSCRIPTIONS" },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("unknown type fails loudly", async () => {
    const ctx = ctxWith({});
    const res = await runFinalCheck(
      { type: "brand-new-future-check-kind" } as unknown as Parameters<
        typeof runFinalCheck
      >[0],
      { runtime, ctx },
    );
    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/no handler registered/);
  });

  it("known final check types reject unknown fields", async () => {
    const ctx = ctxWith({
      actionsCalled: [{ actionName: "GMAIL_ACTION" }],
    });
    const res = await runFinalCheck(
      {
        type: "selectedAction",
        actionName: "GMAIL_ACTION",
        actionNmae: "typo",
      } as unknown as Parameters<typeof runFinalCheck>[0],
      { runtime, ctx },
    );
    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/unknown field/);
  });

  it("scenario schema rejects unknown fields on strict final checks", () => {
    expect(() =>
      scenario({
        id: "strict-final-check",
        title: "Strict final check",
        domain: "scenario-runner",
        turns: [],
        finalChecks: [
          {
            type: "gmailMockRequest",
            method: "GET",
            path: "/gmail/v1/users/me/messages",
            unexpected: true,
          },
        ],
      }),
    ).toThrow(/unknown field/);
  });

  it("gmailActionArguments matches structured GMAIL_ACTION parameters", async () => {
    const ctx = ctxWith({
      actionsCalled: [
        {
          actionName: "GMAIL_ACTION",
          parameters: {
            subaction: "manage",
            operation: "archive",
            details: { messageIds: ["msg-newsletter"] },
          },
        },
      ],
    });
    const res = await runFinalCheck(
      {
        type: "gmailActionArguments",
        subaction: "manage",
        operation: "archive",
        fields: { "details.messageIds": "msg-newsletter" },
      },
      { runtime, ctx },
    );
    expect(res.status).toBe("passed");
  });

  it("gmail final checks read the mock request ledger structurally", async () => {
    await withMockGoogleLedger(
      [
        {
          method: "POST",
          path: "/gmail/v1/users/me/drafts",
          body: { message: { raw: "encoded" } },
        },
        {
          method: "POST",
          path: "/gmail/v1/users/me/messages/batchModify",
          body: {
            ids: ["msg-newsletter"],
            removeLabelIds: ["INBOX"],
          },
        },
      ],
      async () => {
        const ctx = ctxWith({});
        const draft = await runFinalCheck(
          { type: "gmailDraftCreated" },
          { runtime, ctx },
        );
        expect(draft.status).toBe("passed");

        const batch = await runFinalCheck(
          {
            type: "gmailBatchModify",
            body: { ids: "msg-newsletter", removeLabelIds: "INBOX" },
          },
          { runtime, ctx },
        );
        expect(batch.status).toBe("passed");

        const noRealWrite = await runFinalCheck(
          { type: "gmailNoRealWrite" },
          { runtime, ctx },
        );
        expect(noRealWrite.status).toBe("passed");
      },
    );
  });

  it("custom predicate undefined = pass, string = fail", async () => {
    const ctx = ctxWith({});
    const ok = await runFinalCheck(
      {
        type: "custom",
        name: "pass",
        predicate: () => undefined,
      },
      { runtime, ctx },
    );
    expect(ok.status).toBe("passed");
    const bad = await runFinalCheck(
      {
        type: "custom",
        name: "bad",
        predicate: () => "something broke",
      },
      { runtime, ctx },
    );
    expect(bad.status).toBe("failed");
    expect(bad.detail).toMatch(/something broke/);
  });
});
