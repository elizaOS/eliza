/**
 * Verifies TASKS:cancel.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { promoteSubactionsToActions } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
// CANCEL_TASK is `TASKS { action: "cancel" }`.
import { cancelTaskAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  session,
  state,
} from "../../src/test-utils/action-test-utils.js";

const cancelOptions = { parameters: { action: "cancel" } };

describe("TASKS:cancel", () => {
  it("rejects an undeclared history verb on the promoted cancel tool", async () => {
    const cancel = promoteSubactionsToActions(cancelTaskAction).find(
      (action) => action.name === "TASKS_CANCEL",
    );
    if (!cancel) throw new Error("TASKS_CANCEL was not promoted");
    const svc = serviceMock();

    const result = await cancel.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456" }),
      state,
      { parameters: { verb: "history", sessionId: "abcdef123456" } },
      callback(),
    );

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("Call TASKS_HISTORY"),
    });
    expect(svc.cancelSession).not.toHaveBeenCalled();
  });

  it("keeps cancel planner-visible on the umbrella action", () => {
    expect(
      cancelTaskAction.parameters?.find(
        (parameter) => parameter.name === "action",
      )?.schema.enum,
    ).toContain("cancel");
  });

  it("cancels a session by id", async () => {
    const svc = serviceMock();
    const result = await cancelTaskAction.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456" }),
      state,
      cancelOptions,
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      stoppedSessions: ["abcdef123456"],
      status: "canceled",
    });
    expect(svc.cancelSession).toHaveBeenCalledWith("abcdef123456");
  });
  it("cancels all sessions when all=true", async () => {
    const svc = serviceMock();
    const result = await cancelTaskAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      cancelOptions,
      callback(),
    );
    expect(result).toMatchObject({
      success: true,
      data: { canceledCount: 1, stoppedSessions: ["abcdef123456"] },
      effectReceipts: [
        {
          outcome: "applied",
          resource: { kind: "acp.session", id: "abcdef123456" },
          commit: {
            kind: "durable",
            id: "session-store:cancel:abcdef123456:1",
            committedAt: "2026-05-03T10:00:00.000Z",
          },
        },
      ],
    });
  });
  it("fails an all-session cancel closed when any child receipt is missing", async () => {
    const sessions = [
      session({ id: "session-one" }),
      session({ id: "session-two" }),
    ];
    const svc = serviceMock({
      listSessions: vi.fn(() => sessions),
      cancelSession: vi.fn(async (sessionId: string) =>
        sessionId === "session-one"
          ? {
              sessionId,
              receipt: {
                operation: "cancel",
                authority: "session_store",
                receiptId: "session-store:cancel:session-one:1",
                committedAt: "2026-05-03T10:00:00.000Z",
                status: "cancelled",
              },
            }
          : undefined,
      ),
    });

    const result = await cancelTaskAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      cancelOptions,
      callback(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "AUTHORITATIVE_RECEIPT_MISSING",
      data: { outcomeUnknown: true, reconciliationRequired: true },
      effectReceipts: [
        {
          outcome: "failed",
          failure: { acceptance: "unknown", retryable: false },
        },
      ],
    });
    expect(
      result?.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
    ).toBe(false);
  });
  it("reports SERVICE_UNAVAILABLE when ACP is missing", async () => {
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          cancelOptions,
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
  });
  it("reports SESSION_NOT_FOUND when target missing", async () => {
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(serviceMock({ getSession: vi.fn(() => undefined) })),
          memory({ sessionId: "x" }),
          state,
          cancelOptions,
          callback(),
        )
      )?.error,
    ).toBe("SESSION_NOT_FOUND");
  });
  it("propagates underlying cancel failure", async () => {
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(
            serviceMock({
              cancelSession: vi.fn(async () => {
                throw new Error("boom");
              }),
            }),
          ),
          memory({ sessionId: "abcdef123456" }),
          state,
          cancelOptions,
          callback(),
        )
      )?.error,
    ).toBe("boom");
  });
});
