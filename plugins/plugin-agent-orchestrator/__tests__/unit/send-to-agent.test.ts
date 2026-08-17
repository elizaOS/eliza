/**
 * Verifies TASKS:send.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
// SEND_TO_AGENT is `TASKS { action: "send" }`; the action variable imports as
// `sendToAgentAction` (an alias on the parent).
import { sendToAgentAction } from "../../src/actions/tasks.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:send", () => {
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
    });
    expect(svc.sendToSession).toHaveBeenCalledWith("abcdef123456", "continue");
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

  it("does not revive a one-shot session after its durable task is done", async () => {
    const svc = serviceMock();
    const taskService = {
      getTaskForSession: vi.fn(async () => ({
        id: "durable-task-1",
        status: "done",
      })),
    };
    const runtime = runtimeWith(svc);
    runtime.getService = vi.fn((serviceType: string) =>
      serviceType === OrchestratorTaskService.serviceType ? taskService : svc,
    );

    const result = await sendToAgentAction.handler(
      runtime,
      memory({
        source: "sub_agent",
        text: "[sub-agent: completed task — task_complete]\nAll checks passed.",
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
          task: "Continue and report again",
        },
      },
      callback(),
    );

    expect(result).toMatchObject({
      success: true,
      continueChain: false,
      data: {
        sessionId: "abcdef123456",
        durableTaskId: "durable-task-1",
        terminalTaskStatus: "done",
        suppressedTerminalFollowUp: true,
      },
    });
    expect(svc.sendToSession).not.toHaveBeenCalled();
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
