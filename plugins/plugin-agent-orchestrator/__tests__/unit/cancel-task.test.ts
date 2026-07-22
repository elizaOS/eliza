/**
 * Verifies TASKS:cancel.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
// CANCEL_TASK is `TASKS { action: "cancel" }`.
import { cancelTaskAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const cancelOptions = { parameters: { action: "cancel" } };

describe("TASKS:cancel", () => {
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
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(svc),
          memory({ all: true }),
          state,
          cancelOptions,
          callback(),
        )
      )?.data,
    ).toEqual({ canceledCount: 1, stoppedSessions: ["abcdef123456"] });
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
