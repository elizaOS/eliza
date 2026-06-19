import { describe, expect, it, vi } from "vitest";
// Post-consolidation: STOP_AGENT is `TASKS { action: "stop_agent" }`.
import { stopAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const stopOptions = { parameters: { action: "stop_agent" } };

describe("TASKS:stop_agent", () => {
  it("stops a specific session", async () => {
    const svc = serviceMock();
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456" }),
          state,
          stopOptions,
          callback(),
        )
      )?.data,
    ).toMatchObject({ sessionId: "abcdef123456", agentType: "codex" });
  });
  it("stops all sessions when all=true", async () => {
    const svc = serviceMock();
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(svc),
          memory({ all: true }),
          state,
          stopOptions,
          callback(),
        )
      )?.data,
    ).toEqual({ stoppedCount: 1 });
  });
  it("reports SERVICE_UNAVAILABLE when ACP is missing", async () => {
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          stopOptions,
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
  });
  it("reports SESSION_NOT_FOUND when target missing", async () => {
    expect(
      (
        await stopAgentAction.handler(
          runtimeWith(serviceMock({ getSession: vi.fn(() => undefined) })),
          memory({ sessionId: "nope" }),
          state,
          stopOptions,
          callback(),
        )
      )?.error,
    ).toBe("SESSION_NOT_FOUND");
  });
  it("propagates underlying stop failure", async () => {
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
          stopOptions,
          callback(),
        )
      )?.error,
    ).toBe("boom");
  });
});
