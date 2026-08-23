/**
 * Direct unit coverage for `registerConfigureCommand`. Drives the real
 * Commander program: empty registration, append-after-sibling order, the
 * after-help docs link, and the configure action's printed guidance. Does
 * not mock commander, theme, or formatDocsLink.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { formatDocsLink, theme } from "@elizaos/shared";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configureModule from "./register.configure";
import { registerConfigureCommand } from "./register.configure";

const CONFIG_PATH = path.join(homedir(), ".local/state/eliza/eliza.json");

function makeProgram(): {
  program: Command;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (chunk) => {
      out.push(chunk);
    },
    writeErr: (chunk) => {
      err.push(chunk);
    },
  });
  return { program, out, err };
}

function parseUserArgs(program: Command, args: string[]): CommanderError {
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

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
    },
  };
}

function expectedActionLines(): string[] {
  return [
    `\n${theme.heading("Configuration")}\n`,
    "Set values with:",
    `  ${theme.command("eliza config get <key>")}     Read a config value`,
    `  Edit ~/.local/state/eliza/eliza.json directly for full control.\n`,
    "Common environment variables:",
    `  ${theme.command("ANTHROPIC_API_KEY")}    Anthropic (Claude)`,
    `  ${theme.command("OPENAI_API_KEY")}       OpenAI (GPT)`,
    `  ${theme.command("GOOGLE_API_KEY")}       Google (Gemini)\n`,
  ];
}

describe("registerConfigureCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports only registerConfigureCommand", () => {
    expect(Object.keys(configureModule)).toEqual(["registerConfigureCommand"]);
    expect(typeof registerConfigureCommand).toBe("function");
  });

  it("registers a single configure command on an empty program", () => {
    const { program } = makeProgram();
    expect(program.commands).toEqual([]);

    registerConfigureCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "configure",
    ]);
    const configure = findCommand(program, "configure");
    expect(configure).toBeDefined();
    expect(configure?.description()).toBe("Configuration guidance");
    expect(configure?.alias()).toBeUndefined();
    expect(configure?.aliases()).toEqual([]);
    expect(configure?.options).toEqual([]);
    expect(configure?.commands).toEqual([]);
    expect(configure?.registeredArguments).toEqual([]);
  });

  it("does not register config or a missing sibling name", () => {
    const { program } = makeProgram();
    registerConfigureCommand(program);

    expect(findCommand(program, "config")).toBeUndefined();
    expect(findCommand(program, "configuration")).toBeUndefined();
    expect(findCommand(program, "")).toBeUndefined();
  });

  it("appends configure after an already-registered sibling", () => {
    const { program } = makeProgram();
    program.command("db").description("Database helpers");

    registerConfigureCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "db",
      "configure",
    ]);
    expect(findCommand(program, "db")?.description()).toBe("Database helpers");
  });

  it("prints static configuration guidance without writing the config file", () => {
    const existed = existsSync(CONFIG_PATH);
    const mtimeMs = existed ? statSync(CONFIG_PATH).mtimeMs : undefined;

    const { program } = makeProgram();
    registerConfigureCommand(program);
    const capture = captureConsoleLog();

    program.parse(["configure"], { from: "user" });

    capture.restore();
    expect(capture.lines).toEqual(expectedActionLines());
    expect(existsSync(CONFIG_PATH)).toBe(existed);
    if (existed) {
      expect(statSync(CONFIG_PATH).mtimeMs).toBe(mtimeMs);
    }
  });

  it("appends the configuration docs link after --help", () => {
    const { program, out } = makeProgram();
    registerConfigureCommand(program);

    const error = parseUserArgs(program, ["configure", "--help"]);
    expect(error.code).toBe("commander.helpDisplayed");

    const help = out.join("");
    expect(help).toContain("Usage:");
    expect(help).toContain("Configuration guidance");
    expect(help).toMatch(/-h, --help/);
    // Commander strips SGR from after-help text, so "Docs:" is unstyled even
    // though the thunk calls theme.muted. The docs URL is still the live
    // formatDocsLink result (non-TTY fallback is the canonical URL).
    expect(help).toContain(
      `Docs: ${formatDocsLink("/configuration", "docs.eliza.ai/configuration")}`,
    );
  });

  it("rejects an unknown option on configure", () => {
    const { program } = makeProgram();
    registerConfigureCommand(program);

    const error = parseUserArgs(program, ["configure", "--task"]);
    expect(error.code).toBe("commander.unknownOption");
    expect(error.message).toMatch(/--task/);
  });
});
