import type { ScenarioContext } from "@elizaos/scenario-schema";
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

  it("unknown type returns unknown-kind, not failure", async () => {
    const ctx = ctxWith({});
    const res = await runFinalCheck(
      { type: "brand-new-future-check-kind" } as unknown as Parameters<
        typeof runFinalCheck
      >[0],
      { runtime, ctx },
    );
    expect(res.status).toBe("unknown-kind");
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
