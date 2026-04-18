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
