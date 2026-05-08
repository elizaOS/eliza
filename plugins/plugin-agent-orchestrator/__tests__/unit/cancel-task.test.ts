import { describe, expect, it, vi } from "vitest";
import { cancelTaskAction } from "../../src/actions/cancel-task.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("CANCEL_TASK", () => {
  it("validates with sessions", async () => {
    expect(
      await cancelTaskAction.validate(
        runtimeWith(serviceMock()),
        memory(),
        state,
      ),
    ).toBe(true);
    expect(
      await cancelTaskAction.validate(runtimeWith(undefined), memory(), state),
    ).toBe(false);
  });
  it("cancels a session and all sessions", async () => {
    const svc = serviceMock();
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456" }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toMatchObject({
      sessionId: "abcdef123456",
      stoppedSessions: ["abcdef123456"],
      status: "canceled",
    });
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(svc),
          memory({ all: true }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toEqual({ canceledCount: 1, stoppedSessions: ["abcdef123456"] });
  });
  it("handles service, missing session, and failure", async () => {
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          {},
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
    expect(
      (
        await cancelTaskAction.handler(
          runtimeWith(serviceMock({ getSession: vi.fn(() => undefined) })),
          memory({ sessionId: "x" }),
          state,
          {},
          callback(),
        )
      )?.error,
    ).toBe("SESSION_NOT_FOUND");
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
          {},
          callback(),
        )
      )?.error,
    ).toBe("boom");
  });
});
