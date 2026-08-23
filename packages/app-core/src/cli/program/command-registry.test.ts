/**
 * Direct unit coverage for `registerProgramCommands`. Drives the real
 * registrar against a live Commander program and asserts the observed
 * registration order, the default `process.argv` hand-off, and the
 * argv-dependent lazy sub-CLI branches without replacing the module
 * under test or its per-command registrars.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerProgramCommands } from "./command-registry";

const ROOT_ARGV = ["node", "eliza"] as const;

/** Commands registered before the argv-dependent lazy sub-CLIs. */
const CORE_COMMAND_NAMES = [
  "start",
  "run",
  "benchmark",
  "capability-router",
  "setup",
  "doctor:mtp",
  "doctor",
  "db",
  "configure",
  "config",
  "dashboard",
  "update",
  "auth",
] as const;

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name());
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

describe("registerProgramCommands", () => {
  const previousDisableLazy = process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;

  afterEach(() => {
    if (previousDisableLazy === undefined) {
      delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = previousDisableLazy;
    }
  });

  it("registers core commands in source order, then both lazy sub-CLIs", () => {
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);

    expect(commandNames(program)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
      "models",
    ]);
  });

  it("registers each top-level name exactly once on an empty program", () => {
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);

    const names = commandNames(program);
    for (const name of names) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    }
  });

  it("registers start and its run alias as sibling commands", () => {
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);

    const start = findCommand(program, "start");
    const run = findCommand(program, "run");
    expect(start?.description()).toBe("Start the elizaOS agent runtime");
    expect(run?.description()).toBe("Alias for start");
  });

  it("attaches adopt-codex under the single auth group created earlier", () => {
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);

    const authCommands = program.commands.filter(
      (command) => command.name() === "auth",
    );
    expect(authCommands).toHaveLength(1);

    const subNames = authCommands[0]?.commands.map((command) => command.name());
    expect(subNames).toEqual(["reset", "dev-login", "adopt-codex"]);
  });

  it("forwards an explicit argv so only the matching lazy sub-CLI is registered", () => {
    const pluginsProgram = new Command();
    registerProgramCommands(pluginsProgram, [...ROOT_ARGV, "plugins"]);
    expect(commandNames(pluginsProgram)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
    ]);

    const modelsProgram = new Command();
    registerProgramCommands(modelsProgram, [...ROOT_ARGV, "models"]);
    expect(commandNames(modelsProgram)).toEqual([
      ...CORE_COMMAND_NAMES,
      "models",
    ]);
  });

  it("registers both lazy sub-CLIs when argv has no primary command", () => {
    const emptyProgram = new Command();
    registerProgramCommands(emptyProgram, []);
    expect(commandNames(emptyProgram)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
      "models",
    ]);

    const shortProgram = new Command();
    registerProgramCommands(shortProgram, ["node"]);
    expect(commandNames(shortProgram)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
      "models",
    ]);
  });

  it("registers both lazy sub-CLIs when the primary command is not a sub-CLI", () => {
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV, "start"]);
    expect(commandNames(program)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
      "models",
    ]);
  });

  it("registers both lazy sub-CLIs when argv contains help or version flags", () => {
    for (const flag of ["--help", "-h", "--version", "-v", "-V"] as const) {
      const program = new Command();
      registerProgramCommands(program, [...ROOT_ARGV, "plugins", flag]);
      expect(commandNames(program), flag).toEqual([
        ...CORE_COMMAND_NAMES,
        "plugins",
        "models",
      ]);
    }
  });

  it("uses process.argv when the argv argument is omitted", () => {
    const previousArgv = process.argv;
    process.argv = [...ROOT_ARGV, "models"];
    try {
      const program = new Command();
      registerProgramCommands(program);
      expect(commandNames(program)).toEqual([...CORE_COMMAND_NAMES, "models"]);
    } finally {
      process.argv = previousArgv;
    }
  });

  it("does not add lazy placeholders when ELIZA_DISABLE_LAZY_SUBCOMMANDS is set", () => {
    process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = "1";
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);
    expect(commandNames(program)).toEqual([...CORE_COMMAND_NAMES]);
  });

  it("does not treat a falsey lazy-disable env as eager registration", () => {
    process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = "0";
    const program = new Command();
    registerProgramCommands(program, [...ROOT_ARGV]);
    expect(commandNames(program)).toEqual([
      ...CORE_COMMAND_NAMES,
      "plugins",
      "models",
    ]);
  });

  it("mutates the provided program and returns undefined", () => {
    const program = new Command();
    const result = registerProgramCommands(program, [...ROOT_ARGV]);
    expect(result).toBeUndefined();
    expect(program.commands.length).toBeGreaterThan(0);
  });
});
