/**
 * Verifies TASKS:stop_agent.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
// STOP_AGENT is `TASKS { action: "stop_agent" }`.
import { stopAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  session,
  state,
} from "../../src/test-utils/action-test-utils.js";

const stopOptions = { parameters: { action: "stop_agent" } };

describe("TASKS:stop_agent", () => {
  it("keeps stop_agent planner-visible on the umbrella action", () => {
    expect(
      stopAgentAction.parameters?.find(
        (parameter) => parameter.name === "action",
      )?.schema.enum,
    ).toContain("stop_agent");
  });

  it("stops a specific session", async () => {
    const svc = serviceMock();
    const result = await stopAgentAction.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456" }),
      state,
      stopOptions,
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      agentType: "codex",
    });
    expect(svc.stopSession).toHaveBeenCalledWith("abcdef123456");
  });
  it("stops all sessions when all=true", async () => {
    const svc = serviceMock();
    const result = await stopAgentAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      stopOptions,
      callback(),
    );
    expect(result).toMatchObject({
      success: true,
      data: { stoppedCount: 1, stoppedSessions: ["abcdef123456"] },
      effectReceipts: [
        {
          outcome: "applied",
          resource: { kind: "acp.session", id: "abcdef123456" },
          commit: {
            kind: "durable",
            id: "session-store:stop:abcdef123456:1",
            committedAt: "2026-05-03T10:00:00.000Z",
          },
        },
      ],
    });
  });
  it("fails an all-session stop closed when any child receipt is missing", async () => {
    const sessions = [
      session({ id: "session-one" }),
      session({ id: "session-two" }),
    ];
    const svc = serviceMock({
      listSessions: vi.fn(() => sessions),
      stopSession: vi.fn(async (sessionId: string) =>
        sessionId === "session-one"
          ? {
              sessionId,
              receipt: {
                operation: "stop",
                authority: "session_store",
                receiptId: "session-store:stop:session-one:1",
                committedAt: "2026-05-03T10:00:00.000Z",
                status: "stopped",
              },
            }
          : undefined,
      ),
    });

    const result = await stopAgentAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      stopOptions,
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
