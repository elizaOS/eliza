/**
 * Direct unit coverage for `configureProgramHelp`. Drives a real Commander
 * program through every export and branch: name/version/global flags, themed
 * help terms, stdout heading coloring vs stderr passthrough, error coloring,
 * the one-shot banner `beforeAll` gate, and the root-only Examples/`afterAll`
 * block. Does not mock the module under test or commander.
 */
import { theme } from "@elizaos/shared";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitCliBanner,
  formatCliBannerLine,
  hasEmittedCliBanner,
} from "../banner";
import { replaceCliName, resolveCliName } from "../cli-name";
import { configureProgramHelp } from "./help";

const PROGRAM_VERSION = "9.9.9-test";

const EXAMPLES = [
  ["eliza", "Start Eliza in the interactive TUI."],
  ["eliza start", "Start the classic runtime/chat loop."],
  ["eliza dashboard", "Open the Control UI in your browser."],
  ["eliza setup", "Initialize the XDG state-dir config and agent workspace."],
  ["eliza config get agents.defaults.model.primary", "Read a config value."],
  ["eliza models", "Show configured model providers."],
  ["eliza plugins list", "List available plugins."],
  ["eliza update", "Check for and install the latest version."],
  ["eliza update channel beta", "Switch to the beta release channel."],
] as const;

const stdout = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };

function configure(version = PROGRAM_VERSION): Command {
  const program = new Command();
  program.exitOverride();
  configureProgramHelp(program, version);
  return program;
}

function optionByLong(program: Command, long: string) {
  return program.options.find((option) => option.long === long);
}

function captureWrite(stream: NodeJS.WriteStream, fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof stream.write);
  try {
    fn();
    return chunks.join("");
  } finally {
    spy.mockRestore();
  }
}

function parseUser(
  program: Command,
  args: string[],
): CommanderError | undefined {
  try {
    program.parse(args, { from: "user" });
    return undefined;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }
}

/** Commander strips CSI from addHelpText; compare the visible help users read. */
function visible(text: string): string {
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text.replace(csi, "");
}

function captureOutputHelp(command: Command): string {
  return captureWrite(process.stdout, () => {
    command.outputHelp();
  });
}

describe("configureProgramHelp identity", () => {
  it("stamps the resolved CLI name, empty description, and supplied version", () => {
    const program = configure("2.0.3");
    expect(program.name()).toBe(resolveCliName());
    expect(program.description()).toBe("");
    expect(program.version()).toBe("2.0.3");
  });

  it("preserves an empty version string rather than substituting a default", () => {
    const program = configure("");
    expect(program.version()).toBe("");
  });

  it("wires -v/--version as the version flags, not verbose", () => {
    const program = configure();
    const version = optionByLong(program, "--version");
    expect(version?.flags).toBe("-v, --version");
    expect(optionByLong(program, "--verbose")?.flags).toBe("--verbose");
    expect(optionByLong(program, "--verbose")?.short).toBeUndefined();
  });
});

describe("configureProgramHelp global flags", () => {
  it("registers verbose, debug, dev, profile, and no-color with their descriptions", () => {
    const program = configure();
    expect(program.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining([
        "-v, --version",
        "--verbose",
        "--debug",
        "--dev",
        "--profile <name>",
        "--no-color",
      ]),
    );
    expect(optionByLong(program, "--verbose")?.description).toBe(
      "Enable informational runtime logs",
    );
    expect(optionByLong(program, "--debug")?.description).toBe(
      "Enable debug-level runtime logs",
    );
    expect(optionByLong(program, "--dev")?.description).toBe(
      "Dev profile: isolate state under a named XDG state-dir namespace with separate config and ports",
    );
    expect(optionByLong(program, "--profile")?.description).toBe(
      "Use a named profile with isolated state and config",
    );
    expect(optionByLong(program, "--no-color")?.description).toBe(
      "Disable ANSI colors",
    );
  });

  it("stores false as the --no-color default rather than commander's usual true", () => {
    const program = configure();
    const noColor = optionByLong(program, "--no-color");
    expect(noColor?.defaultValue).toBe(false);
    expect(noColor?.negate).toBe(true);
  });

  it("parses --verbose and --debug as booleans and --profile as the given name", () => {
    const verbose = configure();
    expect(parseUser(verbose, ["--verbose"])).toBeUndefined();
    expect(verbose.opts().verbose).toBe(true);

    const debug = configure();
    expect(parseUser(debug, ["--debug"])).toBeUndefined();
    expect(debug.opts().debug).toBe(true);

    const profile = configure();
    expect(parseUser(profile, ["--profile", "work"])).toBeUndefined();
    expect(profile.opts().profile).toBe("work");
  });

  it("rejects --profile with no name instead of inventing a default", () => {
    const program = configure();
    const error = parseUser(program, ["--profile"]);
    expect(error?.code).toBe("commander.optionMissingArgument");
    expect(error?.message).toMatch(/--profile/);
  });

  it("exits with the version error and the stamped version for -v and --version", () => {
    const short = configure("1.2.3");
    const long = configure("1.2.3");
    expect(parseUser(short, ["-v"])).toMatchObject({
      code: "commander.version",
      message: "1.2.3",
    });
    expect(parseUser(long, ["--version"])).toMatchObject({
      code: "commander.version",
      message: "1.2.3",
    });
  });
});

describe("configureProgramHelp terms", () => {
  it("themes option flags through optionTerm", () => {
    const program = configure();
    const help = program.createHelp();
    const verbose = optionByLong(program, "--verbose");
    expect(verbose).toBeDefined();
    expect(help.optionTerm(verbose as NonNullable<typeof verbose>)).toBe(
      theme.option(verbose?.flags ?? ""),
    );
  });

  it("themes the command name through subcommandTerm, not the full usage", () => {
    const program = configure();
    const start = program.command("start");
    const help = program.createHelp();
    expect(help.subcommandTerm(start)).toBe(theme.command("start"));
    expect(help.subcommandTerm(start)).not.toBe(start.usage());
  });
});

describe("configureProgramHelp output", () => {
  it("colors Usage/Options/Commands headings on stdout, not mid-line copies", () => {
    const program = configure();
    program.command("start").description("Usage: nested");
    const out = captureWrite(process.stdout, () => {
      program.outputHelp();
    });
    expect(out).toContain(theme.heading("Usage:"));
    expect(out).toContain(theme.heading("Options:"));
    expect(out).toContain(theme.heading("Commands:"));
    expect(out).toContain("Usage: nested");
    const themed = theme.heading("Usage:");
    if (themed !== "Usage:") {
      expect(out).not.toContain(`${themed} nested`);
    }
  });

  it("writes error-channel help through writeErr without heading coloring", () => {
    const program = configure();
    program.command("start").description("start");
    const err = captureWrite(process.stderr, () => {
      program.outputHelp({ error: true });
    });
    expect(err).toContain("Usage:");
    expect(err).toContain("Options:");
    expect(err).toContain("Commands:");
    const themedUsage = theme.heading("Usage:");
    if (themedUsage !== "Usage:") {
      expect(err).not.toContain(themedUsage);
    }
  });

  it("wraps commander error text with theme.error before writing stderr", () => {
    const program = configure();
    let caught: CommanderError | undefined;
    const err = captureWrite(process.stderr, () => {
      caught = parseUser(program, ["--not-a-real-flag"]);
    });
    expect(caught?.code).toBe("commander.unknownOption");
    expect(err).toContain(
      theme.error("error: unknown option '--not-a-real-flag'\n"),
    );
  });
});

describe("configureProgramHelp beforeAll banner", () => {
  const originalIsTty = stdout.isTTY;

  afterEach(() => {
    stdout.isTTY = originalIsTty;
  });

  it("prepends the formatted banner when the one-shot guard is still clear", () => {
    expect(hasEmittedCliBanner()).toBe(false);
    const program = configure(PROGRAM_VERSION);
    const help = visible(captureOutputHelp(program));
    const line = formatCliBannerLine(PROGRAM_VERSION, { richTty: false });
    expect(help.startsWith(`\n${line}\n`)).toBe(true);
  });

  it("omits the banner once emitCliBanner has fired, even on a later program", () => {
    stdout.isTTY = true;
    captureWrite(process.stdout, () => {
      emitCliBanner(PROGRAM_VERSION, {
        argv: ["node", "eliza", "start"],
        commit: "abc1234",
        richTty: false,
      });
    });
    expect(hasEmittedCliBanner()).toBe(true);

    const program = configure(PROGRAM_VERSION);
    const help = visible(captureOutputHelp(program));
    const line = formatCliBannerLine(PROGRAM_VERSION, { richTty: false });
    expect(help.startsWith(`\n${line}\n`)).toBe(false);
    expect(help).not.toContain(line);
  });
});

describe("configureProgramHelp afterAll examples", () => {
  it("appends Examples and the docs link only when help is for the root", () => {
    const program = configure();
    const cliName = resolveCliName();
    const help = visible(captureOutputHelp(program));
    expect(help).toContain("Examples:");
    expect(help).toContain("Docs:");
    expect(help).toContain("docs.eliza.ai/cli");
    for (const [cmd, desc] of EXAMPLES) {
      expect(help).toContain(`  ${replaceCliName(cmd, cliName)}`);
      expect(help).toContain(`    ${desc}`);
    }
  });

  it("returns no Examples block when help is rendered for a subcommand", () => {
    const program = configure();
    const start = program.command("start").description("Start");
    const subHelp = visible(captureOutputHelp(start));
    expect(subHelp).not.toContain("Examples:");
    expect(subHelp).not.toContain("docs.eliza.ai/cli");
    expect(subHelp).not.toContain("Start Eliza in the interactive TUI.");
    expect(visible(captureOutputHelp(program))).toContain("Examples:");
  });

  it("does not treat a second root program as the first program's afterAll target", () => {
    const first = configure();
    const second = configure();
    first.command("only-on-first");
    const firstHelp = visible(captureOutputHelp(first));
    const secondHelp = visible(captureOutputHelp(second));
    expect(firstHelp).toContain("Examples:");
    expect(secondHelp).toContain("Examples:");
    expect(secondHelp).not.toContain("only-on-first");
    expect(firstHelp).toContain("only-on-first");
  });
});
