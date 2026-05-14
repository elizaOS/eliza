import { afterEach, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import {
  closeAllTerminalSessions,
  closeTerminal,
  connectTerminal,
  readTerminal,
  resizeTerminal,
  sendInputTerminal,
} from "../platform/terminal.js";
import { ComputerUseService } from "../services/computer-use-service.js";

function createMockRuntime(): IAgentRuntime {
  return {
    character: {},
    getSetting(key: string) {
      return key === "COMPUTER_USE_APPROVAL_MODE" ? "full_control" : undefined;
    },
    getService() {
      return null;
    },
  } as IAgentRuntime;
}

async function readUntil(sessionId: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5000;
  let output = "";
  while (Date.now() < deadline) {
    output += readTerminal(sessionId).output ?? "";
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return output;
}

describe("terminal interactive sessions", () => {
  afterEach(() => {
    closeAllTerminalSessions();
  });

  it("creates, writes to, reads from, resizes, and closes a session", async () => {
    const created = await connectTerminal({ cwd: "/tmp", cols: 90, rows: 28 });
    expect(created.success).toBe(true);
    expect(created.sessionId).toBeDefined();
    expect(created.cols).toBe(90);
    expect(created.rows).toBe(28);

    const sessionId = created.sessionId as string;
    const resized = resizeTerminal({ sessionId, cols: 120, rows: 32 });
    expect(resized.success).toBe(true);
    expect(resized.cols).toBe(120);
    expect(resized.rows).toBe(32);

    const typed = sendInputTerminal({
      sessionId,
      text: "printf 'terminal-session-test\\n'\n",
    });
    expect(typed.success).toBe(true);

    const output = await readUntil(sessionId, /terminal-session-test/);
    expect(output).toContain("terminal-session-test");

    const closed = closeTerminal(sessionId);
    expect(closed.success).toBe(true);
  });

  it("routes parity terminal commands through the service", async () => {
    const service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;
    try {
      const created = await service.executeCommand("terminal_create", {
        cwd: "/tmp",
        cols: 88,
        rows: 26,
      });
      expect(created.success).toBe(true);
      expect(created.sessionId).toBeDefined();
      expect(created.cols).toBe(88);
      expect(created.rows).toBe(26);

      const sessionId = created.sessionId as string;
      const resized = await service.executeCommand("terminal_resize", {
        session_id: sessionId,
        cols: 110,
        rows: 31,
      });
      expect(resized.success).toBe(true);
      expect(resized.cols).toBe(110);
      expect(resized.rows).toBe(31);

      const sent = await service.executeCommand("terminal_send_input", {
        session_id: sessionId,
        input: "printf 'service-terminal-parity\\n'\n",
      });
      expect(sent.success).toBe(true);

      const output = await readUntil(sessionId, /service-terminal-parity/);
      expect(output).toContain("service-terminal-parity");

      const closed = await service.executeCommand("terminal_close", {
        session_id: sessionId,
      });
      expect(closed.success).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
