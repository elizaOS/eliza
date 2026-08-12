/**
 * Verifies TASKS:send.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
// SEND_TO_AGENT is `TASKS { action: "send" }`; the action variable imports as
// `sendToAgentAction` (an alias on the parent).
import { sendToAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:send", () => {
  const acceptedPromptResult = {
    sessionId: "abcdef123456",
    response: "ok",
    finalText: "ok",
    stopReason: "end_turn",
    durationMs: 5,
    exitCode: 0,
    signal: null,
    providerDisposition: {
      kind: "accepted" as const,
      receipt: {
        receiptId: "native:protocol-session:42",
        acceptedAt: "2026-05-03T10:00:00.000Z",
        transport: "native" as const,
        protocolSessionId: "protocol-session",
        requestId: "42",
      },
    },
  } as const;

  it("keeps send planner-visible on the umbrella action", () => {
    expect(
      sendToAgentAction.parameters?.find(
        (parameter) => parameter.name === "action",
      )?.schema.enum,
    ).toContain("send");
  });

  it("sends input via action=send", async () => {
    const svc = serviceMock();
    const result = await sendToAgentAction.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456", input: "continue" }),
      state,
      { parameters: { action: "send" } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      input: "continue",
      providerAccepted: true,
    });
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: { kind: "acp.session", id: "abcdef123456" },
        commit: {
          kind: "provider_accepted",
          id: "native:abcdef123456:2",
          committedAt: "2026-05-03T10:00:00.000Z",
        },
      }),
    ]);
    expect(svc.sendToSession).toHaveBeenCalledWith("abcdef123456", "continue");
  });

  it.each([
    {
      name: "error",
      result: {
        ...acceptedPromptResult,
        stopReason: "error",
        exitCode: 1,
        error: "provider failed after receiving the prompt",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_ERROR_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "cancelled",
      result: {
        ...acceptedPromptResult,
        stopReason: "cancelled",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_CANCELLED_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "stopped",
      result: {
        ...acceptedPromptResult,
        stopReason: "stopped",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_STOPPED_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "nonzero exit",
      result: {
        ...acceptedPromptResult,
        exitCode: 7,
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_NONZERO_EXIT",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "partial max-token response",
      result: {
        ...acceptedPromptResult,
        stopReason: "max_tokens",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_MAX_TOKENS_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "partial max-turn response",
      result: {
        ...acceptedPromptResult,
        stopReason: "max_turn_requests",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_MAX_TURN_REQUESTS_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "interrupted response",
      result: {
        ...acceptedPromptResult,
        stopReason: "interrupted",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_INTERRUPTED_UNSETTLED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "signal termination",
      result: {
        ...acceptedPromptResult,
        signal: "SIGTERM" as const,
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_SIGNALED",
          effectsMayHaveOccurred: true,
        },
      },
    },
    {
      name: "mismatched session",
      result: { ...acceptedPromptResult, sessionId: "different-session" },
    },
    {
      name: "unknown stop reason",
      result: {
        ...acceptedPromptResult,
        stopReason: "future_terminal_shape",
        providerDisposition: {
          kind: "unknown" as const,
          code: "ACP_PROMPT_RESPONSE_INVALID",
          effectsMayHaveOccurred: true,
        },
      },
    },
  ])(
    "fails closed and requires reconciliation for a $name result",
    async ({ result: promptResult }) => {
      const svc = serviceMock({
        sendToSession: vi.fn(async () => promptResult),
      });

      const result = await sendToAgentAction.handler(
        runtimeWith(svc),
        memory({ sessionId: "abcdef123456", input: "continue" }),
        state,
        { parameters: { action: "send" } },
        callback(),
      );

      expect(result).toMatchObject({
        success: false,
        error: "ACP_SEND_ACCEPTANCE_UNKNOWN",
        text: expect.stringContaining("outcome is unknown"),
        data: {
          sessionId: "abcdef123456",
          providerAccepted: false,
          providerAcceptance: "unknown",
          outcomeUnknown: true,
          reconciliationRequired: true,
          retryable: false,
        },
      });
      expect(result?.text).not.toContain("provider failed");
      expect(result?.effectReceipts).toEqual([
        expect.objectContaining({
          outcome: "failed",
          resource: { kind: "acp.session", id: "abcdef123456" },
          failure: {
            code: "ACP_SEND_ACCEPTANCE_UNKNOWN",
            retryable: false,
            acceptance: "unknown",
          },
        }),
      ]);
      expect(
        result?.effectReceipts?.some(
          (receipt) => receipt.outcome === "applied",
        ),
      ).toBe(false);
    },
  );

  it.each(["refusal", "content_filter"])(
    "settles explicit provider %s as rejected rather than unknown or applied",
    async (stopReason) => {
      const svc = serviceMock({
        sendToSession: vi.fn(async () => ({
          ...acceptedPromptResult,
          stopReason,
          providerDisposition: {
            kind: "rejected" as const,
            code: "ACP_PROMPT_REJECTED",
            message: "raw provider detail",
          },
        })),
      });

      const result = await sendToAgentAction.handler(
        runtimeWith(svc),
        memory({ sessionId: "abcdef123456", input: "continue" }),
        state,
        { parameters: { action: "send" } },
        callback(),
      );

      expect(result).toMatchObject({
        success: false,
        error: "ACP_PROMPT_REJECTED",
        data: {
          providerAccepted: false,
          providerAcceptance: "rejected",
          reconciliationRequired: false,
          retryable: false,
        },
      });
      expect(result?.text).not.toContain("raw provider detail");
      expect(result?.effectReceipts).toEqual([
        expect.objectContaining({
          outcome: "failed",
          failure: {
            code: "ACP_PROMPT_REJECTED",
            retryable: false,
            acceptance: "rejected",
          },
        }),
      ]);
    },
  );

  it("fails closed when the provider result is structurally incomplete", async () => {
    const svc = serviceMock({
      sendToSession: vi.fn(async () => ({
        sessionId: "abcdef123456",
        stopReason: "end_turn",
      })),
    });

    const result = await sendToAgentAction.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456", input: "continue" }),
      state,
      { parameters: { action: "send" } },
      callback(),
    );

    expect(result).toMatchObject({
      success: false,
      error: "ACP_SEND_ACCEPTANCE_UNKNOWN",
      data: {
        providerAccepted: false,
        outcomeUnknown: true,
        reconciliationRequired: true,
      },
    });
  });

  it("continues the originating sub-agent for routed task_complete follow-ups", async () => {
    const svc = serviceMock();
    const result = await sendToAgentAction.handler(
      runtimeWith(svc),
      memory({
        source: "sub_agent",
        text: "[sub-agent: disk check (opencode) — task_complete]\n[tool output: Get root filesystem usage]\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       387G  223G  165G  58% /",
        metadata: {
          subAgent: true,
          subAgentEvent: "task_complete",
          subAgentSessionId: "abcdef123456",
        },
      }),
      state,
      {
        parameters: {
          action: "send",
          task: "Disk usage: 58% (223 GB used, 165 GB available)",
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(svc.sendToSession).toHaveBeenCalledWith(
      "abcdef123456",
      expect.stringContaining("Continue the original task"),
    );
    const input = svc.sendToSession.mock.calls[0]?.[1] as string;
    expect(input).toContain("Previous completion:");
    expect(input).toContain("Get root filesystem usage");
    expect(input).toContain("Parent follow-up:");
    expect(input).toContain("Run any additional commands needed");
  });

  it("sends keys via action=send", async () => {
    const svc = serviceMock();
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", keys: "ctrl-c" }),
          state,
          { parameters: { action: "send" } },
          callback(),
        )
      )?.data,
    ).toMatchObject({ keys: "ctrl-c" });
  });

  it("returns NO_INPUT to the planner without posting a raw callback", async () => {
    const sendCallback = callback();
    const result = await sendToAgentAction.handler(
      runtimeWith(serviceMock()),
      memory({ sessionId: "abcdef123456" }),
      state,
      { parameters: { action: "send" } },
      sendCallback,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("NO_INPUT");
    expect(sendCallback).not.toHaveBeenCalled();
  });

  it("returns send failures to the planner without posting a raw callback", async () => {
    const sendCallback = callback();
    const svc = serviceMock({
      sendToSession: vi.fn(async () => {
        throw new Error("ACP session is already busy");
      }),
    });

    const result = await sendToAgentAction.handler(
      runtimeWith(svc),
      memory({ sessionId: "abcdef123456", input: "continue" }),
      state,
      { parameters: { action: "send" } },
      sendCallback,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("ACP session is already busy");
    expect(sendCallback).not.toHaveBeenCalled();
  });

  it("reports SERVICE_UNAVAILABLE when ACP is missing", async () => {
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          { parameters: { action: "send" } },
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
          { parameters: { action: "send" } },
          callback(),
        )
      )?.error,
    ).toBe("NO_SESSION");
  });
});
