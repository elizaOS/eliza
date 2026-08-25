/**
 * Direct unit coverage for `buildProgram`. Drives the real assembler and
 * asserts the Commander program it returns: name/version stamp, global flags,
 * registered commands (including argv-dependent lazy sub-CLIs), preAction hook
 * installation, and root-only help text. Collaborators are not replaced.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliName } from "../cli-name";
import { CLI_VERSION } from "../version";
import { buildProgram } from "./build-program";

const ORIGINAL_ARGV = process.argv.slice();
const ORIGINAL_LAZY = process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;

/** Top-level commands `registerProgramCommands` wires for a bare `eliza` argv. */
const DEFAULT_COMMAND_NAMES = [
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

function captureOutputHelp(program: Command): string {
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
    program.outputHelp();
    return chunks.join("");
  } finally {
    spy.mockRestore();
  }
}

describe("buildProgram", () => {
  beforeEach(() => {
    process.argv = ["node", "eliza"];
    delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    if (ORIGINAL_LAZY === undefined) {
      delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = ORIGINAL_LAZY;
    }
  });

  it("returns a Commander program, not a singleton", () => {
    const first = buildProgram();
    const second = buildProgram();
    expect(first).toBeInstanceOf(Command);
    expect(second).toBeInstanceOf(Command);
    expect(first).not.toBe(second);
  });

  it("stamps the resolved CLI name and CLI_VERSION", () => {
    const program = buildProgram();
    expect(program.name()).toBe(resolveCliName());
    expect(program.version()).toBe(CLI_VERSION);
    expect(typeof CLI_VERSION).toBe("string");
    expect(CLI_VERSION.length).toBeGreaterThan(0);
  });

  it("registers the global flags configureProgramHelp defines", () => {
    const program = buildProgram();
    const flags = program.options.map((option) => option.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        "-v, --version",
        "--verbose",
        "--debug",
        "--dev",
        "--profile <name>",
        "--no-color",
      ]),
    );
  });

  it("registers every top-level command in registry order for a bare argv", () => {
    const program = buildProgram();
    expect(commandNames(program)).toEqual([...DEFAULT_COMMAND_NAMES]);
  });

  it("attaches adopt-codex under the existing auth command", () => {
    const program = buildProgram();
    const auth = program.commands.find((command) => command.name() === "auth");
    expect(auth).toBeDefined();
    expect(auth?.commands.map((command) => command.name())).toContain(
      "adopt-codex",
    );
    expect(commandNames(program).filter((name) => name === "auth")).toEqual([
      "auth",
    ]);
  });

  it("installs a preAction hook on the assembled program", () => {
    const program = buildProgram() as Command & {
      _lifeCycleHooks?: { preAction?: unknown[] };
    };
    const hooks = program._lifeCycleHooks?.preAction ?? [];
    expect(hooks.length).toBe(1);
    expect(typeof hooks[0]).toBe("function");
  });

  it("includes the Examples block and CLI docs link only on root help", () => {
    const program = buildProgram();
    const rootHelp = captureOutputHelp(program);
    expect(rootHelp).toMatch(/Examples:/);
    expect(rootHelp).toContain("docs.eliza.ai/cli");
    expect(rootHelp).toContain(CLI_VERSION);

    const start = program.commands.find(
      (command) => command.name() === "start",
    );
    expect(start).toBeDefined();
    const startHelp = captureOutputHelp(start as Command);
    expect(startHelp).not.toMatch(/Examples:/);
    expect(startHelp).not.toContain("docs.eliza.ai/cli");
  });

  it("registers only the named lazy sub-CLI when argv selects one", () => {
    process.argv = ["node", "eliza", "plugins"];
    const program = buildProgram();
    const names = commandNames(program);
    expect(names).toContain("plugins");
    expect(names).not.toContain("models");
  });

  it("still registers both lazy sub-CLIs when argv is --help", () => {
    process.argv = ["node", "eliza", "--help"];
    const program = buildProgram();
    const names = commandNames(program);
    expect(names).toContain("plugins");
    expect(names).toContain("models");
  });
});
