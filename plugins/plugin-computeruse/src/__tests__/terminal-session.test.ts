import { afterEach, describe, expect, it } from "vitest";
import {
  closeAllTerminalSessions,
  closeTerminal,
  connectTerminal,
  readTerminal,
  resizeTerminal,
  sendInputTerminal,
} from "../platform/terminal.js";

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
});
