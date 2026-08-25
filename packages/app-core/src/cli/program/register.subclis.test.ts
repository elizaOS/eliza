/**
 * Direct unit coverage for lazy sub-CLI registration. Drives a live Commander
 * program through `registerSubCliByName` and `registerSubCliCommands` and
 * asserts every exported branch: unknown names, existing-command replacement,
 * argv-dependent placeholders, help/version listing, env-gated eager loads,
 * and the placeholder-to-real swap on first invocation. The plugins and
 * models registrars are the real modules; commander is not mocked.
 */
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSubCliByName,
  registerSubCliCommands,
} from "./register.subclis";

const PLACEHOLDER_PLUGINS_DESCRIPTION = "Plugin management (elizaOS plugins)";
const PLACEHOLDER_MODELS_DESCRIPTION = "Model configuration";
const REAL_PLUGINS_DESCRIPTION =
  "Browse, search, install, and manage elizaOS plugins from the registry";
const REAL_MODELS_DESCRIPTION = "Show configured model providers";

const REAL_PLUGIN_SUBCOMMANDS = [
  "list",
  "search",
  "info",
  "install",
  "uninstall",
  "installed",
  "refresh",
  "test",
  "add-path",
  "paths",
  "config",
  "open",
] as const;

const ORIGINAL_LAZY = process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
const ORIGINAL_ARGV = process.argv.slice();

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name());
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

function childNames(command: Command | undefined): string[] {
  return command?.commands.map((child) => child.name()) ?? [];
}

function makeProgram(): Command {
  const program = new Command();
  program.name("eliza");
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  return program;
}

async function waitForCommands(
  program: Command,
  names: readonly string[],
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const have = commandNames(program);
    if (names.every((name) => have.includes(name))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for ${names.join(", ")}; have ${commandNames(program).join(", ")}`,
  );
}

describe("registerSubCliByName", () => {
  afterEach(() => {
    if (ORIGINAL_LAZY === undefined) {
      delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = ORIGINAL_LAZY;
    }
    process.argv = ORIGINAL_ARGV;
  });

  it("returns false and mutates nothing for a name that is not in the queue", async () => {
    const program = makeProgram();
    program.command("start").description("keep me");

    await expect(registerSubCliByName(program, "start")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "Plugins")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "not-a-sub-cli")).resolves.toBe(
      false,
    );

    expect(commandNames(program)).toEqual(["start"]);
    expect(findCommand(program, "start")?.description()).toBe("keep me");
  });

  it("loads the real plugins CLI when the name matches and no prior command exists", async () => {
    const program = makeProgram();
    program.command("start");

    await expect(registerSubCliByName(program, "plugins")).resolves.toBe(true);

    expect(commandNames(program)).toEqual(["start", "plugins"]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      REAL_PLUGINS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "plugins"))).toEqual([
      ...REAL_PLUGIN_SUBCOMMANDS,
    ]);
    expect(findCommand(program, "models")).toBeUndefined();
  });

  it("loads the real models CLI when the name matches and no prior command exists", async () => {
    const program = makeProgram();

    await expect(registerSubCliByName(program, "models")).resolves.toBe(true);

    expect(commandNames(program)).toEqual(["models"]);
    expect(findCommand(program, "models")?.description()).toBe(
      REAL_MODELS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "models"))).toEqual([]);
    expect(findCommand(program, "plugins")).toBeUndefined();
  });

  it("replaces an existing command of the same name instead of appending a duplicate", async () => {
    const program = makeProgram();
    program.command("plugins").description("stale-plugins");
    program.command("models").description("stale-models");
    program.command("start").description("keep me");

    await expect(registerSubCliByName(program, "plugins")).resolves.toBe(true);
    expect(commandNames(program).filter((name) => name === "plugins")).toEqual([
      "plugins",
    ]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      REAL_PLUGINS_DESCRIPTION,
    );
    expect(findCommand(program, "models")?.description()).toBe("stale-models");
    expect(findCommand(program, "start")?.description()).toBe("keep me");

    await expect(registerSubCliByName(program, "models")).resolves.toBe(true);
    expect(commandNames(program).filter((name) => name === "models")).toEqual([
      "models",
    ]);
    expect(findCommand(program, "models")?.description()).toBe(
      REAL_MODELS_DESCRIPTION,
    );
    expect(findCommand(program, "start")?.description()).toBe("keep me");
  });

  it("stays a single command when the same name is force-loaded twice", async () => {
    const program = makeProgram();

    await expect(registerSubCliByName(program, "models")).resolves.toBe(true);
    await expect(registerSubCliByName(program, "models")).resolves.toBe(true);

    expect(commandNames(program)).toEqual(["models"]);
    expect(findCommand(program, "models")?.description()).toBe(
      REAL_MODELS_DESCRIPTION,
    );
  });
});

describe("registerSubCliCommands", () => {
  afterEach(() => {
    if (ORIGINAL_LAZY === undefined) {
      delete process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = ORIGINAL_LAZY;
    }
    process.argv = ORIGINAL_ARGV;
  });

  it("registers both placeholders in source order when the argv queue is empty", () => {
    const empty = makeProgram();
    registerSubCliCommands(empty, []);
    expect(commandNames(empty)).toEqual(["plugins", "models"]);

    const short = makeProgram();
    registerSubCliCommands(short, ["node"]);
    expect(commandNames(short)).toEqual(["plugins", "models"]);

    const bare = makeProgram();
    registerSubCliCommands(bare, ["node", "eliza"]);
    expect(commandNames(bare)).toEqual(["plugins", "models"]);
    expect(findCommand(bare, "plugins")?.description()).toBe(
      PLACEHOLDER_PLUGINS_DESCRIPTION,
    );
    expect(findCommand(bare, "models")?.description()).toBe(
      PLACEHOLDER_MODELS_DESCRIPTION,
    );
    expect(childNames(findCommand(bare, "plugins"))).toEqual([]);
    expect(childNames(findCommand(bare, "models"))).toEqual([]);
  });

  it("registers both placeholders when the primary command is not a sub-CLI", () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "start"]);
    expect(commandNames(program)).toEqual(["plugins", "models"]);
  });

  it("registers only the matching placeholder when argv names a single sub-CLI", () => {
    const plugins = makeProgram();
    registerSubCliCommands(plugins, ["node", "eliza", "plugins", "list"]);
    expect(commandNames(plugins)).toEqual(["plugins"]);
    expect(findCommand(plugins, "plugins")?.description()).toBe(
      PLACEHOLDER_PLUGINS_DESCRIPTION,
    );
    expect(findCommand(plugins, "models")).toBeUndefined();

    const models = makeProgram();
    registerSubCliCommands(models, ["node", "eliza", "models"]);
    expect(commandNames(models)).toEqual(["models"]);
    expect(findCommand(models, "models")?.description()).toBe(
      PLACEHOLDER_MODELS_DESCRIPTION,
    );
    expect(findCommand(models, "plugins")).toBeUndefined();
  });

  it("treats a flag-prefixed token as skipped so a later sub-CLI name still matches", () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "--verbose", "models"]);
    expect(commandNames(program)).toEqual(["models"]);
  });

  it("registers both placeholders when the primary sits behind a -- terminator", () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "--", "plugins"]);
    expect(commandNames(program)).toEqual(["plugins", "models"]);
  });

  it("registers both placeholders when argv contains help or version flags", () => {
    for (const flag of ["--help", "-h", "--version", "-v", "-V"] as const) {
      const program = makeProgram();
      registerSubCliCommands(program, ["node", "eliza", "plugins", flag]);
      expect(commandNames(program), flag).toEqual(["plugins", "models"]);
    }
  });

  it("still lists both placeholders when --help appears after the -- terminator", () => {
    const program = makeProgram();
    registerSubCliCommands(program, [
      "node",
      "eliza",
      "plugins",
      "--",
      "--help",
    ]);
    expect(commandNames(program)).toEqual(["plugins", "models"]);
  });

  it("uses process.argv when the argv argument is omitted", () => {
    process.argv = ["node", "eliza", "models"];
    const program = makeProgram();
    registerSubCliCommands(program);
    expect(commandNames(program)).toEqual(["models"]);
  });

  it("does not treat a falsey lazy-disable env as eager registration", () => {
    process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = "0";
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza"]);
    expect(commandNames(program)).toEqual(["plugins", "models"]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      PLACEHOLDER_PLUGINS_DESCRIPTION,
    );
  });

  it("eager-loads both real sub-CLIs when ELIZA_DISABLE_LAZY_SUBCOMMANDS is truthy", async () => {
    process.env.ELIZA_DISABLE_LAZY_SUBCOMMANDS = "1";
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza"]);

    await waitForCommands(program, ["plugins", "models"]);

    expect(commandNames(program).filter((name) => name === "plugins")).toEqual([
      "plugins",
    ]);
    expect(commandNames(program).filter((name) => name === "models")).toEqual([
      "models",
    ]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      REAL_PLUGINS_DESCRIPTION,
    );
    expect(findCommand(program, "models")?.description()).toBe(
      REAL_MODELS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "plugins"))).toEqual([
      ...REAL_PLUGIN_SUBCOMMANDS,
    ]);
  });

  it("swaps the models placeholder for the real command and re-parses on first invoke", async () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "models"]);
    expect(findCommand(program, "models")?.description()).toBe(
      PLACEHOLDER_MODELS_DESCRIPTION,
    );

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    try {
      await program.parseAsync(["node", "eliza", "models"]);
    } finally {
      spy.mockRestore();
    }

    expect(commandNames(program)).toEqual(["models"]);
    expect(findCommand(program, "models")?.description()).toBe(
      REAL_MODELS_DESCRIPTION,
    );
    expect(logs.some((line) => line.includes("Model providers"))).toBe(true);
    expect(logs.some((line) => line.includes("xAI (Grok)"))).toBe(true);
  });

  it("swaps the plugins placeholder for the real command before the re-parse", async () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "plugins"]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      PLACEHOLDER_PLUGINS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "plugins"))).toEqual([]);

    let thrown: unknown;
    try {
      await program.parseAsync([
        "node",
        "eliza",
        "plugins",
        "--not-a-real-plugins-option",
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(findCommand(program, "plugins")?.description()).toBe(
      REAL_PLUGINS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "plugins"))).toEqual([
      ...REAL_PLUGIN_SUBCOMMANDS,
    ]);
    expect(commandNames(program).filter((name) => name === "plugins")).toEqual([
      "plugins",
    ]);
    expect(thrown).toBeInstanceOf(CommanderError);
  });

  it("lets registerSubCliByName replace a live placeholder with the real CLI", async () => {
    const program = makeProgram();
    registerSubCliCommands(program, ["node", "eliza", "plugins"]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      PLACEHOLDER_PLUGINS_DESCRIPTION,
    );

    await expect(registerSubCliByName(program, "plugins")).resolves.toBe(true);

    expect(commandNames(program)).toEqual(["plugins"]);
    expect(findCommand(program, "plugins")?.description()).toBe(
      REAL_PLUGINS_DESCRIPTION,
    );
    expect(childNames(findCommand(program, "plugins"))).toEqual([
      ...REAL_PLUGIN_SUBCOMMANDS,
    ]);
  });
});
