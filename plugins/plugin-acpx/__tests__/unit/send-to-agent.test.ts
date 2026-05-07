import { describe, expect, it, vi } from "vitest";
import { sendToAgentAction } from "../../src/actions/send-to-agent.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("SEND_TO_AGENT", () => {
  it("validates only with active sessions", async () => {
    expect(
      await sendToAgentAction.validate(
        runtimeWith(serviceMock()),
        memory(),
        state,
      ),
    ).toBe(true);
    expect(
      await sendToAgentAction.validate(
        runtimeWith(serviceMock({ listSessions: vi.fn(() => []) })),
        memory(),
        state,
      ),
    ).toBe(false);
  });
  it("sends input, keys, and reports no session/missing service", async () => {
    const svc = serviceMock();
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", input: "continue" }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toMatchObject({ sessionId: "abcdef123456", input: "continue" });
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", keys: "ctrl-c" }),
          state,
          {},
          callback(),
        )
      )?.data,
    ).toMatchObject({ keys: "ctrl-c" });
    expect(
      (
        await sendToAgentAction.handler(
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
        await sendToAgentAction.handler(
          runtimeWith(
            serviceMock({
              listSessions: vi.fn(() => []),
              getSession: vi.fn(() => undefined),
            }),
          ),
          memory({ input: "x" }),
          state,
          {},
          callback(),
        )
      )?.error,
    ).toBe("NO_SESSION");
  });
});
