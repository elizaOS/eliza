import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureProgramHelp: vi.fn(),
  registerPreActionHooks: vi.fn(),
  registerProgramCommands: vi.fn(),
}));

vi.mock("commander", () => {
  class Command {
    _actions: unknown[] = [];
    action(fn: unknown) {
      this._actions.push(fn);
      return this;
    }
    option() {
      return this;
    }
  }
  return { Command };
});
vi.mock("../../version", () => ({ CLI_VERSION: "9.9.9" }));
vi.mock("../command-registry", () => ({
  registerProgramCommands: (...a: unknown[]) =>
    mocks.registerProgramCommands(...a),
}));
vi.mock("../help", () => ({
  configureProgramHelp: (...a: unknown[]) => mocks.configureProgramHelp(...a),
}));
vi.mock("../preaction", () => ({
  registerPreActionHooks: (...a: unknown[]) =>
    mocks.registerPreActionHooks(...a),
}));

import { Command } from "commander";
import { buildProgram } from "../build-program.ts";

describe("buildProgram", () => {
  it("assembles the program with help, hooks, and commands", () => {
    const program = buildProgram();
    expect(program).toBeInstanceOf(Command);
    expect(mocks.configureProgramHelp).toHaveBeenCalledWith(
      expect.any(Command),
      "9.9.9",
    );
    expect(mocks.registerPreActionHooks).toHaveBeenCalledWith(
      expect.any(Command),
      "9.9.9",
    );
    expect(mocks.registerProgramCommands).toHaveBeenCalledWith(
      expect.any(Command),
    );
  });
});
