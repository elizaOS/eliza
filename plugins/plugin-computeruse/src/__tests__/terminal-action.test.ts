import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/terminal.js", () => ({
  clearTerminal: vi.fn(() => ({ success: true, message: "cleared" })),
  connectTerminal: vi.fn(() => ({ success: true, session_id: "term_1", cwd: "/tmp" })),
  executeCommand: vi.fn(() => ({ success: true, output: "ok", session_id: "term_1", cwd: "/tmp" })),
  executeTerminal: vi.fn(() => ({ success: true, output: "ok", session_id: "term_1", cwd: "/tmp" })),
  readTerminal: vi.fn(() => ({ success: true, output: "ok", session_id: "term_1", cwd: "/tmp" })),
  typeTerminal: vi.fn(() => ({ success: true, message: "typed", session_id: "term_1", cwd: "/tmp" })),
  closeTerminal: vi.fn(() => ({ success: true, message: "closed", session_id: "term_1", cwd: "/tmp" })),
}));

import { terminalAction } from "../actions/terminal-action.js";
import {
  clearTerminal,
  connectTerminal,
  executeCommand,
  executeTerminal,
  readTerminal,
  typeTerminal,
  closeTerminal,
} from "../platform/terminal.js";

describe("terminalAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("describes the terminal surface", () => {
    expect(terminalAction.name).toBe("TERMINAL_ACTION");
    expect(terminalAction.description).toContain("terminal_connect");
    expect(terminalAction.description).toContain("terminal_execute");
    expect(terminalAction.description).toContain("execute_command");
    expect(terminalAction.description).toContain("terminal_close");
  });

  it("connects a session", async () => {
    const result = await terminalAction.handler(
      {} as any,
      { content: { action: "terminal_connect", cwd: "/tmp" } } as any,
      undefined,
      { parameters: { action: "terminal_connect", cwd: "/tmp" } } as any,
    );

    expect(connectTerminal).toHaveBeenCalledWith({ cwd: "/tmp" });
    expect(result).toEqual({ success: true, session_id: "term_1", cwd: "/tmp" });
  });

  it("normalizes execute_command to terminal_execute", async () => {
    const result = await terminalAction.handler(
      {} as any,
      { content: { action: "execute_command", command: "echo hi" } } as any,
      undefined,
      { parameters: { action: "execute_command", command: "echo hi" } } as any,
    );

    expect(executeCommand).toHaveBeenCalledWith({
      command: "echo hi",
      timeout: undefined,
      session_id: undefined,
    });
    expect(executeTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, output: "ok" });
  });

  it("routes the remaining terminal actions", async () => {
    await terminalAction.handler(
      {} as any,
      { content: { action: "terminal_read" } } as any,
      undefined,
      { parameters: { action: "terminal_read", session_id: "term_1" } } as any,
    );
    await terminalAction.handler(
      {} as any,
      { content: { action: "terminal_type", text: "ls" } } as any,
      undefined,
      { parameters: { action: "terminal_type", text: "ls" } } as any,
    );
    await terminalAction.handler(
      {} as any,
      { content: { action: "terminal_clear" } } as any,
      undefined,
      { parameters: { action: "terminal_clear" } } as any,
    );
    await terminalAction.handler(
      {} as any,
      { content: { action: "terminal_close" } } as any,
      undefined,
      { parameters: { action: "terminal_close" } } as any,
    );

    expect(readTerminal).toHaveBeenCalled();
    expect(typeTerminal).toHaveBeenCalledWith({ text: "ls", session_id: undefined });
    expect(clearTerminal).toHaveBeenCalled();
    expect(closeTerminal).toHaveBeenCalled();
  });
});
