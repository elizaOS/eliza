/**
 * Direct unit coverage for the CLI program barrel. Imports `buildProgram`
 * from `./program` — the public re-export `runCli` loads — and drives the
 * real Commander assembly: name/version, global flags, command registration
 * order, nested subcommands, lazy plugins/models argv branches, unknown
 * commands, and independent instances. Does not mock commander or the
 * register modules.
 */
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliName } from "./cli-name";
import { buildProgram } from "./program";
import { buildProgram as buildProgramFromAssembly } from "./program/build-program";
import { CLI_VERSION } from "./version";

const FULL_TOP_LEVEL_COMMANDS = [
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
  "plugins",
  "models",
] as const;

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name());
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

function childNames(command: Command | undefined): string[] {
  return command?.commands.map((child) => child.name()) ?? [];
}

function withArgv<T>(argv: string[], fn: () => T): T {
  const previous = process.argv;
  process.argv = argv;
  try {
    return fn();
  } finally {
    process.argv = previous;
  }
}

function overrideExit(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) {
    overrideExit(child);
  }
}

function parseUserArgs(program: Command, args: string[]): CommanderError {
  overrideExit(program);
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }
  throw new Error(`parse(${JSON.stringify(args)}) returned without exiting`);
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write);
  try {
    fn();
    return chunks.join("");
  } finally {
    spy.mockRestore();
  }
}

describe("buildProgram barrel", () => {
  afterEach(() => {
    delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
  });

  it("re-exports the same buildProgram function as the assembly module", () => {
    expect(buildProgram).toBe(buildProgramFromAssembly);
    expect(typeof buildProgram).toBe("function");
  });
});

describe("buildProgram assembly", () => {
  afterEach(() => {
    delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
  });

  it("returns a Commander program named for the resolved CLI with CLI_VERSION", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    expect(program).toBeInstanceOf(Command);
    expect(program.name()).toBe(resolveCliName());
    expect(program.version()).toBe(CLI_VERSION);
    expect(program.version()).toMatch(/\S/);
  });

  it("registers the global verbose/debug/dev/profile and --no-color flags", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    const flags = program.options.map((option) => option.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--verbose",
        "--debug",
        "--dev",
        "--profile <name>",
        "--no-color",
      ]),
    );
  });

  it("registers top-level commands in registry order when the queue is empty", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    expect(commandNames(program)).toEqual([...FULL_TOP_LEVEL_COMMANDS]);
  });

  it("still registers both lazy sub-CLIs when the primary command is unrelated", () => {
    const program = withArgv(["node", "eliza", "start"], () => buildProgram());
    expect(commandNames(program)).toEqual([...FULL_TOP_LEVEL_COMMANDS]);
  });

  it("registers only the matching lazy sub-CLI when argv names plugins", () => {
    const program = withArgv(["node", "eliza", "plugins", "list"], () =>
      buildProgram(),
    );
    const names = commandNames(program);
    expect(names).toContain("plugins");
    expect(names).not.toContain("models");
    expect(names).toEqual([
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
      "plugins",
    ]);
  });

  it("registers only the matching lazy sub-CLI when argv names models", () => {
    const program = withArgv(["node", "eliza", "models"], () => buildProgram());
    const names = commandNames(program);
    expect(names).toContain("models");
    expect(names).not.toContain("plugins");
    expect(names.at(-1)).toBe("models");
  });

  it("registers both lazy sub-CLIs when argv is --help even if a sub-CLI is named", () => {
    const program = withArgv(["node", "eliza", "plugins", "--help"], () =>
      buildProgram(),
    );
    expect(commandNames(program)).toEqual([...FULL_TOP_LEVEL_COMMANDS]);
  });

  it("returns undefined for a command that was never registered", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    expect(findCommand(program, "completion")).toBeUndefined();
    expect(findCommand(program, "not-a-command")).toBeUndefined();
    expect(findCommand(program, "")).toBeUndefined();
  });

  it("wires nested subcommands onto config, db, auth, update, and capability-router", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    expect(childNames(findCommand(program, "config"))).toEqual([
      "get",
      "path",
      "show",
    ]);
    expect(childNames(findCommand(program, "db"))).toEqual(["reset"]);
    expect(childNames(findCommand(program, "auth"))).toEqual([
      "reset",
      "dev-login",
      "adopt-codex",
    ]);
    expect(childNames(findCommand(program, "update"))).toEqual([
      "status",
      "channel",
    ]);
    expect(childNames(findCommand(program, "capability-router"))).toEqual([
      "connect",
      "conformance",
    ]);
    expect(childNames(findCommand(program, "start"))).toEqual([]);
    expect(childNames(findCommand(program, "doctor"))).toEqual([]);
  });

  it("registers start and run as sibling commands, not aliases of one command", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    const start = findCommand(program, "start");
    const run = findCommand(program, "run");
    expect(start).toBeDefined();
    expect(run).toBeDefined();
    expect(start).not.toBe(run);
    expect(start?.description()).toBe("Start the elizaOS agent runtime");
    expect(run?.description()).toBe("Alias for start");
    expect(start?.options.map((option) => option.long)).toEqual([
      "--connection-key",
    ]);
    expect(run?.options.map((option) => option.long)).toEqual([
      "--connection-key",
    ]);
  });

  it("builds independent program instances that do not share the command list", () => {
    const first = withArgv(["node", "eliza"], () => buildProgram());
    const second = withArgv(["node", "eliza"], () => buildProgram());
    expect(first).not.toBe(second);
    expect(commandNames(first)).toEqual(commandNames(second));
    first.command("only-on-first");
    expect(findCommand(first, "only-on-first")).toBeDefined();
    expect(findCommand(second, "only-on-first")).toBeUndefined();
  });
});

describe("buildProgram parse", () => {
  it("exits with the unknown-command error for a missing top-level name", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    const error = parseUserArgs(program, ["definitely-not-a-command"]);
    expect(error.code).toBe("commander.unknownCommand");
    expect(error.message).toMatch(/definitely-not-a-command/);
  });

  it("exits with the version error and writes CLI_VERSION for -v and --version", () => {
    const dashV = withArgv(["node", "eliza"], () => buildProgram());
    const long = withArgv(["node", "eliza"], () => buildProgram());
    const fromShort = parseUserArgs(dashV, ["-v"]);
    const fromLong = parseUserArgs(long, ["--version"]);
    expect(fromShort.code).toBe("commander.version");
    expect(fromLong.code).toBe("commander.version");
    expect(fromShort.message).toBe(CLI_VERSION);
    expect(fromLong.message).toBe(CLI_VERSION);
  });

  it("exits with helpDisplayed for --help and includes Examples only on the root", () => {
    const program = withArgv(["node", "eliza"], () => buildProgram());
    let error: CommanderError | undefined;
    const rootHelp = captureStdout(() => {
      error = parseUserArgs(program, ["--help"]);
    });
    expect(error?.code).toBe("commander.helpDisplayed");
    expect(rootHelp).toMatch(/Examples:/);
    expect(rootHelp).toMatch(/Docs:/);
    expect(rootHelp).toContain("start");
    expect(rootHelp).toContain("doctor");

    const startProgram = withArgv(["node", "eliza"], () => buildProgram());
    const startHelp = captureStdout(() => {
      parseUserArgs(startProgram, ["start", "--help"]);
    });
    expect(startHelp).not.toMatch(/Examples:/);
    expect(startHelp).toMatch(/Start the elizaOS agent runtime/);
  });
});
