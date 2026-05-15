import { describe, expect, it, vi } from "vitest";
// Post-consolidation: SEND_TO_AGENT is `TASKS { action: "send" }`. The action
// variable still imports as `sendToAgentAction` (alias on the parent).
import { sendToAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:send", () => {
  it("sends input via action=send", async () => {
    const svc = serviceMock();
    expect(
      (
        await sendToAgentAction.handler(
          runtimeWith(svc),
          memory({ sessionId: "abcdef123456", input: "continue" }),
          state,
          { parameters: { action: "send" } },
          callback(),
        )
      )?.data,
    ).toMatchObject({ sessionId: "abcdef123456", input: "continue" });
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
