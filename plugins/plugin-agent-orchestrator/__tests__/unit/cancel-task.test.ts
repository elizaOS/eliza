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
  sessionMutation,
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
  it("treats an empty all-session cancel as a proved no-op", async () => {
    const result = await cancelTaskAction.handler(
      runtimeWith(serviceMock({ listSessions: vi.fn(() => []) })),
      memory({ all: true }),
      state,
      cancelOptions,
      callback(),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        canceledCount: 0,
        stoppedSessions: [],
        appliedSessionIds: [],
        failedSessionIds: [],
      },
      effectReceipts: [{ outcome: "noop" }],
    });
  });
  it("preserves mixed all-session cancel effects after every child settles", async () => {
    const sessions = [
      session({ id: "session-one" }),
      session({ id: "session-two" }),
      session({ id: "session-three" }),
    ];
    const first = Promise.withResolvers<ReturnType<typeof sessionMutation>>();
    const third = Promise.withResolvers<ReturnType<typeof sessionMutation>>();
    const attempted: string[] = [];
    const svc = serviceMock({
      listSessions: vi.fn(() => sessions),
      cancelSession: vi.fn((sessionId: string) => {
        attempted.push(sessionId);
        if (sessionId === "session-one") return first.promise;
        if (sessionId === "session-two") {
          return Promise.reject(new Error("private cancel transport detail"));
        }
        return third.promise;
      }),
    });
    const delivered = callback();

    const pending = cancelTaskAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      cancelOptions,
      delivered,
    );
    await vi.waitFor(() =>
      expect(attempted).toEqual(sessions.map(({ id }) => id)),
    );
    third.resolve(sessionMutation("session-three", "cancel"));
    await Promise.resolve();
    first.resolve(sessionMutation("session-one", "cancel"));
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      error: "ACP_BATCH_PARTIAL_EFFECT",
      text: expect.stringContaining("remaining session outcomes are unknown"),
      data: {
        canceledCount: 2,
        stoppedSessions: ["session-one", "session-three"],
        appliedSessionIds: ["session-one", "session-three"],
        failedSessionIds: ["session-two"],
        mutationFailures: [
          {
            sessionId: "session-two",
            code: "ACP_SESSION_MUTATION_REJECTED",
            acceptance: "unknown",
            retryable: false,
          },
        ],
        outcomeUnknown: true,
        reconciliationRequired: true,
        retryable: false,
      },
      effectReceipts: [
        {
          outcome: "failed",
          resource: { kind: "acp.session", id: "session-one" },
          artifacts: expect.arrayContaining([
            { kind: "acp.session", id: "session-three" },
            {
              kind: "acp.session-mutation-receipt",
              id: "session-store:cancel:session-one:1",
            },
            {
              kind: "acp.session-mutation-receipt",
              id: "session-store:cancel:session-three:1",
            },
          ]),
          failure: {
            code: "ACP_BATCH_PARTIAL_EFFECT",
            acceptance: "unknown",
            retryable: false,
          },
        },
      ],
    });
    expect(svc.cancelSession).toHaveBeenCalledTimes(3);
    expect(
      result?.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "private cancel transport detail",
    );
    expect(JSON.stringify(delivered.mock.calls)).not.toContain(
      "private cancel transport detail",
    );
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
