import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  formatDocsLink: vi.fn((_p: string, label: string) => label),
  theme: {
    muted: vi.fn((t: string) => `m(${t})`),
    heading: vi.fn((t: string) => `h(${t})`),
    command: vi.fn((t: string) => `c(${t})`),
  },
}));

vi.mock("@elizaos/shared", () => ({
  formatDocsLink: (...a: unknown[]) => mocks.formatDocsLink(...a),
  theme: mocks.theme,
}));

import { registerConfigureCommand } from "./register.configure.ts";

function fakeProgram() {
  const cmd: {
    description: ReturnType<typeof vi.fn>;
    addHelpText: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
  } = {
    description: vi.fn(() => cmd),
    addHelpText: vi.fn(() => cmd),
    action: vi.fn(() => cmd),
  };
  const program = {
    command: vi.fn(() => cmd),
  };
  return { program, cmd };
}

describe("registerConfigureCommand", () => {
  it("registers a configure command with help text and an action", () => {
    const { program, cmd } = fakeProgram();
    registerConfigureCommand(program as never);
    expect(program.command).toHaveBeenCalledWith("configure");
    expect(cmd.description).toHaveBeenCalledWith("Configuration guidance");
    expect(cmd.addHelpText).toHaveBeenCalledWith("after", expect.any(Function));
    expect(cmd.action).toHaveBeenCalledWith(expect.any(Function));
  });

  it("prints configuration guidance when the action runs", () => {
    const { program, cmd } = fakeProgram();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerConfigureCommand(program as never);
    const action = cmd.action.mock.calls[0][0] as () => void;
    action();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("h(Configuration)"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ANTHROPIC_API_KEY"),
    );
    log.mockRestore();
  });
});
