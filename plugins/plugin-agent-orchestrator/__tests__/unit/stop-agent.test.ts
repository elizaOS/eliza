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
  sessionMutation,
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
  it("treats an empty all-session stop as a proved no-op", async () => {
    const result = await stopAgentAction.handler(
      runtimeWith(serviceMock({ listSessions: vi.fn(() => []) })),
      memory({ all: true }),
      state,
      stopOptions,
      callback(),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        stoppedCount: 0,
        stoppedSessions: [],
        appliedSessionIds: [],
        failedSessionIds: [],
      },
      effectReceipts: [{ outcome: "noop" }],
    });
  });
  it("preserves mixed all-session stop effects after every child settles", async () => {
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
      stopSession: vi.fn((sessionId: string) => {
        attempted.push(sessionId);
        if (sessionId === "session-one") return first.promise;
        if (sessionId === "session-two") {
          return Promise.reject(new Error("private stop transport detail"));
        }
        return third.promise;
      }),
    });
    const delivered = callback();

    const pending = stopAgentAction.handler(
      runtimeWith(svc),
      memory({ all: true }),
      state,
      stopOptions,
      delivered,
    );
    await vi.waitFor(() =>
      expect(attempted).toEqual(sessions.map(({ id }) => id)),
    );
    third.resolve(sessionMutation("session-three", "stop"));
    await Promise.resolve();
    first.resolve(sessionMutation("session-one", "stop"));
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      error: "ACP_BATCH_PARTIAL_EFFECT",
      text: expect.stringContaining("remaining session outcomes are unknown"),
      data: {
        stoppedCount: 2,
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
              id: "session-store:stop:session-one:1",
            },
            {
              kind: "acp.session-mutation-receipt",
              id: "session-store:stop:session-three:1",
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
    expect(svc.stopSession).toHaveBeenCalledTimes(3);
    expect(
      result?.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "private stop transport detail",
    );
    expect(JSON.stringify(delivered.mock.calls)).not.toContain(
      "private stop transport detail",
    );
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
