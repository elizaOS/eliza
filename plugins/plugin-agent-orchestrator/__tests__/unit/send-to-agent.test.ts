import { describe, expect, it, vi } from "vitest";
// Post-consolidation: SEND_TO_AGENT is `TASKS { op: "send" }`. The action
// variable still imports as `sendToAgentAction` (alias on the parent).
import { sendToAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:send (legacy SEND_TO_AGENT)", () => {
  it("sends input via op=send", async () => {
    const svc = serviceMock();
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", input: "continue" }),
          state,
          { parameters: { op: "send" } },
          callback(),
        )
      )?.data,
    ).toMatchObject({ sessionId: "abcdef123456", input: "continue" });
  });
  it("sends keys via op=send", async () => {
    const svc = serviceMock();
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", keys: "ctrl-c" }),
          state,
          { parameters: { op: "send" } },
          callback(),
        )
      )?.data,
    ).toMatchObject({ keys: "ctrl-c" });
  });
  it("reports SERVICE_UNAVAILABLE when ACP is missing", async () => {
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          { parameters: { op: "send" } },
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
  });
  it("reports NO_SESSION when no active sessions", async () => {
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(
            serviceMock({
              listSessions: vi.fn(() => []),
              getSession: vi.fn(() => undefined),
            }),
          ),
          memory({ input: "x" }),
          state,
          { parameters: { op: "send" } },
          callback(),
        )
      )?.error,
    ).toBe("NO_SESSION");
  });
});
