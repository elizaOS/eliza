import { afterEach, describe, expect, it } from "vitest";
import {
  clearTerminal,
  closeTerminal,
  connectTerminal,
  executeCommand,
  executeTerminal,
  readTerminal,
  typeTerminal,
} from "../platform/terminal.js";

describe("terminal platform", () => {
  afterEach(() => {
    clearTerminal();
    closeTerminal();
  });

  it("creates a session and returns cwd", () => {
    const result = connectTerminal({ cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.cwd).toBe(process.cwd());
    expect(typeof result.session_id).toBe("string");
  });

  it("executes a harmless command and stores output", async () => {
    connectTerminal();
    const result = await executeTerminal({ command: "echo terminal-parity" });
    expect(result.success).toBe(true);
    expect(String(result.output ?? "")).toContain("terminal-parity");

    const read = readTerminal();
    expect(read.success).toBe(true);
    expect(String(read.output ?? "")).toContain("terminal-parity");
  });

  it("supports the execute_command alias", async () => {
    connectTerminal();
    const result = await executeCommand({ command: "echo alias-check" });
    expect(result.success).toBe(true);
    expect(String(result.output ?? "")).toContain("alias-check");
  });

  it("blocks catastrophic commands", async () => {
    connectTerminal();
    const result = await executeTerminal({ command: "rm -rf /" });
    expect(result.success).toBe(false);
    expect(String(result.error ?? "")).toContain("Command blocked");
  });

  it("queues typed text and clears the buffer", () => {
    const session = connectTerminal();
    const typed = typeTerminal({
      text: "ls -la",
      session_id: session.session_id,
    });
    expect(typed.success).toBe(true);
    expect(String(typed.message ?? "")).toContain("queued");

    const cleared = clearTerminal({ session_id: session.session_id });
    expect(cleared.success).toBe(true);
  });

  it("closes a session cleanly", () => {
    const session = connectTerminal();
    const closed = closeTerminal({ session_id: session.session_id });
    expect(closed.success).toBe(true);
    expect(String(closed.message ?? "")).toContain("closed");
  });
});
