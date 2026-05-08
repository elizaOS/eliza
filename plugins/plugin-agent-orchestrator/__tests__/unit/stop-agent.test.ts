import { describe, expect, it, vi } from "vitest";
import { stopAgentAction } from "../../src/actions/stop-agent.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("STOP_AGENT", () => {
  it("validates active sessions", async () => {
    expect(
      await stopAgentAction.validate(
        runtimeWith(serviceMock()),
        memory(),
        state,
      ),
    ).toBe(true);
    expect(
      await stopAgentAction.validate(runtimeWith(undefined), memory(), state),
    ).toBe(false);
  });
  it("stops specific and all sessions", async () => {
    const svc = serviceMock();
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456" }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toMatchObject({ sessionId: "abcdef123456", agentType: "codex" });
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(svc),
          memory({ all: true }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toEqual({ stoppedCount: 1 });
  });
  it("handles missing service, missing session, and generic failure", async () => {
    expect(
      (
        await stopAgentAction.handler(
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
        await stopAgentAction.handler(
          runtimeWith(serviceMock({ getSession: vi.fn(() => undefined) })),
          memory({ sessionId: "nope" }),
          state,
          {},
          callback(),
        )
      )?.error,
    ).toBe("SESSION_NOT_FOUND");
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(
            serviceMock({
              stopSession: vi.fn(async () => {
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
