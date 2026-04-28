import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalAction } from "./terminal.js";

describe("terminalAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("captures terminal output for LLM follow-up without emitting a fixed chat reply", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          ok: true,
          command: "pwd",
          runId: "run-1",
          exitCode: 0,
          stdout: "/Users/shawwalters/eliza-workspace/milady\n",
          stderr: "",
          timedOut: false,
          truncated: false,
          maxDurationMs: 120_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const createMemory = vi.fn(async () => stringToUuid("terminal-memory"));
    const runtime = {
      agentId: stringToUuid("agent-1"),
      createMemory,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = {
      id: stringToUuid("message-1"),
      agentId: stringToUuid("agent-1"),
      entityId: stringToUuid("agent-1"),
      roomId: stringToUuid("room-1"),
      content: {},
    } as Memory;

    const result = (await terminalAction.handler?.(
      runtime,
      message,
      undefined,
      { parameters: { command: "pwd" } } as HandlerOptions,
    )) as ActionResult;

    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { command?: string; clientId?: string; captureOutput?: boolean };
    expect(requestBody).toMatchObject({
      command: "pwd",
      clientId: "runtime-terminal-action",
      captureOutput: true,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Shell command completed: `pwd`");
    expect(result.text).toContain("/Users/shawwalters/eliza-workspace/milady");
    expect(result.text).toContain("SAVE_ATTACHMENT_TO_CLIPBOARD");
    expect(result.text).not.toContain("Running in terminal");
    expect(result.data).toMatchObject({
      actionName: "SHELL_COMMAND",
      command: "pwd",
      exitCode: 0,
      suppressVisibleCallback: true,
    });
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          attachments: [
            expect.objectContaining({
              contentType: "document",
              source: "SHELL_COMMAND",
              text: expect.stringContaining("STDOUT:"),
            }),
          ],
        }),
      }),
      "messages",
    );
  });
});
