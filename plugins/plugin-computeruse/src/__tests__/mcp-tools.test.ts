/**
 * Computer-use MCP server seam (#9170) — pure catalog + dispatch tests. Run in
 * the DEFAULT lane on all platforms (no MCP SDK, no live desktop): they verify
 * the MCP tool surface and that every tool routes to the right
 * ComputerUseService.executeCommand command.
 */

import { describe, expect, it, vi } from "vitest";
import {
  COMPUTERUSE_MCP_TOOLS,
  type ComputerUseCommandRunner,
  dispatchComputerUseMcpTool,
  findComputerUseMcpTool,
} from "../mcp/tools.js";

function fakeRunner(): ComputerUseCommandRunner & {
  calls: Array<{ command: string; params?: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; params?: Record<string, unknown> }> =
    [];
  return {
    calls,
    executeCommand: vi.fn(async (command: string, params = {}) => {
      calls.push({ command, params });
      return { success: true, message: `ran ${command}` };
    }),
  };
}

describe("computer-use MCP tool catalog", () => {
  it("exposes the core CUA verbs with unique names + commands", () => {
    const names = COMPUTERUSE_MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // A representative slice of the surface must be present.
    for (const n of [
      "computer_screenshot",
      "computer_left_click",
      "computer_type",
      "computer_scroll",
      "computer_drag",
      "computer_ocr",
      "computer_set_value",
      "computer_kill_app",
    ]) {
      expect(names, names.join(", ")).toContain(n);
    }
  });

  it("every tool maps to a non-empty executeCommand command", () => {
    for (const t of COMPUTERUSE_MCP_TOOLS) {
      expect(t.command, t.name).toBeTruthy();
      expect(typeof t.destructive).toBe("boolean");
    }
  });

  it("read-only tools are non-destructive; input tools are destructive", () => {
    expect(findComputerUseMcpTool("computer_screenshot")?.destructive).toBe(
      false,
    );
    expect(findComputerUseMcpTool("computer_ocr")?.destructive).toBe(false);
    expect(
      findComputerUseMcpTool("computer_get_cursor_position")?.destructive,
    ).toBe(false);
    expect(findComputerUseMcpTool("computer_left_click")?.destructive).toBe(
      true,
    );
    expect(findComputerUseMcpTool("computer_set_value")?.destructive).toBe(
      true,
    );
  });
});

describe("dispatchComputerUseMcpTool", () => {
  it("routes each tool to its executeCommand command with the given args", async () => {
    const runner = fakeRunner();
    await dispatchComputerUseMcpTool(runner, "computer_left_click", {
      coordinate: [12, 34],
      displayId: 0,
    });
    expect(runner.calls).toEqual([
      { command: "click", params: { coordinate: [12, 34], displayId: 0 } },
    ]);
  });

  it("routes set_value / kill_app / ocr to their commands", async () => {
    const runner = fakeRunner();
    await dispatchComputerUseMcpTool(runner, "computer_set_value", {
      coordinate: [1, 2],
      text: "hi",
    });
    await dispatchComputerUseMcpTool(runner, "computer_kill_app", {
      target: "1234",
    });
    await dispatchComputerUseMcpTool(runner, "computer_ocr", { displayId: 1 });
    expect(runner.calls.map((c) => c.command)).toEqual([
      "set_value",
      "kill_app",
      "ocr",
    ]);
  });

  it("every catalog tool dispatches to its declared command", async () => {
    for (const tool of COMPUTERUSE_MCP_TOOLS) {
      const runner = fakeRunner();
      await dispatchComputerUseMcpTool(runner, tool.name, {});
      expect(runner.calls[0]?.command, tool.name).toBe(tool.command);
    }
  });

  it("throws on an unknown tool", async () => {
    const runner = fakeRunner();
    await expect(
      dispatchComputerUseMcpTool(runner, "computer_nonexistent", {}),
    ).rejects.toThrow(/Unknown computer-use MCP tool/);
    expect(runner.calls).toHaveLength(0);
  });
});
