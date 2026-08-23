/**
 * Direct unit coverage for Commander `preAction` hook wiring. Drives the real
 * `registerPreActionHooks` export through a real Commander program: process-title
 * derivation from the command parent chain, the help/version short-circuit,
 * banner and update-notification skip branches, verbose/debug flag application,
 * and `NODE_NO_WARNINGS` assignment. The hook module is not mocked.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as updateNotifier from "../../services/update-notifier";
import { isVerbose, setVerbose } from "../../utils/globals";
import * as banner from "../banner";
import { resolveCliName } from "../cli-name";
import { registerPreActionHooks } from "./preaction";

const ORIGINAL_ARGV = process.argv.slice();
const ORIGINAL_TITLE = process.title;
const ORIGINAL_NODE_NO_WARNINGS = process.env.NODE_NO_WARNINGS;
const ORIGINAL_HIDE_BANNER = process.env.ELIZA_HIDE_BANNER;
const ORIGINAL_CI = process.env.CI;
const PROGRAM_VERSION = "9.9.9-preaction-test";

type PreActionFn = (
  thisCommand: Command,
  actionCommand: Command,
) => void | Promise<void>;

function getPreAction(program: Command): PreActionFn {
  const hooks = (
    program as Command & {
      _lifeCycleHooks?: { preAction?: PreActionFn[] };
    }
  )._lifeCycleHooks?.preAction;
  const hook = hooks?.[0];
  if (hooks?.length !== 1 || !hook) {
    throw new Error(`expected 1 preAction hook, got ${hooks?.length ?? 0}`);
  }
  return hook;
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut() {},
    writeErr() {},
  });
  program.name(resolveCliName());
  program.helpOption(false);
  registerPreActionHooks(program, PROGRAM_VERSION);
  return program;
}

async function runHook(
  program: Command,
  actionCommand: Command,
): Promise<void> {
  await getPreAction(program)(program, actionCommand);
}

describe("registerPreActionHooks", () => {
  beforeEach(() => {
    process.argv = ["node", "eliza", "start"];
    process.title = "node";
    delete process.env.ELIZA_HIDE_BANNER;
    delete process.env.NODE_NO_WARNINGS;
    process.env.CI = "1";
    setVerbose(false);
    vi.spyOn(banner, "emitCliBanner");
    vi.spyOn(updateNotifier, "scheduleUpdateNotification");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = ORIGINAL_ARGV;
    process.title = ORIGINAL_TITLE;
    setVerbose(false);
    if (ORIGINAL_NODE_NO_WARNINGS === undefined) {
      delete process.env.NODE_NO_WARNINGS;
    } else {
      process.env.NODE_NO_WARNINGS = ORIGINAL_NODE_NO_WARNINGS;
    }
    if (ORIGINAL_HIDE_BANNER === undefined) {
      delete process.env.ELIZA_HIDE_BANNER;
    } else {
      process.env.ELIZA_HIDE_BANNER = ORIGINAL_HIDE_BANNER;
    }
    if (ORIGINAL_CI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = ORIGINAL_CI;
    }
  });

  it("installs a single preAction hook on the program", () => {
    const program = makeProgram();
    expect(typeof getPreAction(program)).toBe("function");
  });

  it("runs before the command action when Commander parses", async () => {
    const program = makeProgram();
    const order: string[] = [];
    program.command("start").action(() => {
      order.push("action");
    });

    await program.parseAsync(["node", "eliza", "start"]);

    expect(order).toEqual(["action"]);
    expect(process.title).toBe(`${resolveCliName()}-start`);
    expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
    expect(updateNotifier.scheduleUpdateNotification).toHaveBeenCalledTimes(1);
  });

  it("sets the process title from a top-level command name", async () => {
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);
    expect(process.title).toBe(`${resolveCliName()}-start`);
  });

  it("walks nested commands up to the top-level command name", async () => {
    const program = makeProgram();
    const plugin = program.command("plugin");
    const nested = plugin.command("nested");
    const leaf = nested.command("leaf");

    await runHook(program, leaf);

    expect(process.title).toBe(`${resolveCliName()}-plugin`);
  });

  it("leaves the process title alone when the command is the CLI itself", async () => {
    const program = makeProgram();
    const before = process.title;
    await runHook(program, program);
    expect(process.title).toBe(before);
  });

  it("leaves the process title alone when the command name is empty", async () => {
    const program = makeProgram();
    const unnamed = new Command("");
    const before = process.title;
    await runHook(program, unnamed);
    expect(unnamed.name()).toBe("");
    expect(process.title).toBe(before);
  });

  it("sets the process title when a root command uses a different name", async () => {
    const program = makeProgram();
    program.name("other");
    await runHook(program, program);
    expect(process.title).toBe(`${resolveCliName()}-other`);
  });

  it("emits the banner and schedules the update check for an ordinary command", async () => {
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);
    expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
    expect(updateNotifier.scheduleUpdateNotification).toHaveBeenCalledTimes(1);
  });

  it.each(["-h", "--help", "-v", "-V", "--version"] as const)(
    "skips banner, notifier, and verbose setup when argv contains %s",
    async (flag) => {
      process.argv = ["node", "eliza", "start", flag];
      const program = makeProgram();
      const start = program.command("start");
      await runHook(program, start);

      expect(process.title).toBe(`${resolveCliName()}-start`);
      expect(banner.emitCliBanner).not.toHaveBeenCalled();
      expect(updateNotifier.scheduleUpdateNotification).not.toHaveBeenCalled();
      expect(isVerbose()).toBe(false);
      expect(process.env.NODE_NO_WARNINGS).toBeUndefined();
    },
  );

  it("still short-circuits when --help appears after the -- terminator", async () => {
    process.argv = ["node", "eliza", "start", "--", "--help"];
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);

    expect(banner.emitCliBanner).not.toHaveBeenCalled();
    expect(updateNotifier.scheduleUpdateNotification).not.toHaveBeenCalled();
    expect(isVerbose()).toBe(false);
  });

  it.each(["1", "true", "yes", "y", "on", "enabled"] as const)(
    "skips the banner when ELIZA_HIDE_BANNER is %s",
    async (value) => {
      process.env.ELIZA_HIDE_BANNER = value;
      const program = makeProgram();
      const start = program.command("start");
      await runHook(program, start);

      expect(banner.emitCliBanner).not.toHaveBeenCalled();
      expect(updateNotifier.scheduleUpdateNotification).not.toHaveBeenCalled();
      expect(isVerbose()).toBe(false);
      expect(process.env.NODE_NO_WARNINGS).toBe("1");
    },
  );

  it.each(["0", "false", "no", "", "  "] as const)(
    "does not treat ELIZA_HIDE_BANNER=%j as a hide request",
    async (value) => {
      process.env.ELIZA_HIDE_BANNER = value;
      const program = makeProgram();
      const start = program.command("start");
      await runHook(program, start);

      expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
      expect(updateNotifier.scheduleUpdateNotification).toHaveBeenCalledTimes(
        1,
      );
    },
  );

  it("skips the banner for the update command", async () => {
    process.argv = ["node", "eliza", "update"];
    const program = makeProgram();
    const update = program.command("update");
    await runHook(program, update);

    expect(banner.emitCliBanner).not.toHaveBeenCalled();
    expect(updateNotifier.scheduleUpdateNotification).not.toHaveBeenCalled();
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
  });

  it("skips the banner for the completion command", async () => {
    process.argv = ["node", "eliza", "completion"];
    const program = makeProgram();
    const completion = program.command("completion");
    await runHook(program, completion);

    expect(banner.emitCliBanner).not.toHaveBeenCalled();
    expect(updateNotifier.scheduleUpdateNotification).not.toHaveBeenCalled();
  });

  it("does not hide the banner when update is not the first command path segment", async () => {
    process.argv = ["node", "eliza", "plugins", "update"];
    const program = makeProgram();
    const plugins = program.command("plugins");
    await runHook(program, plugins);

    expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
    expect(updateNotifier.scheduleUpdateNotification).toHaveBeenCalledTimes(1);
  });

  it("does not hide the banner for an empty command path", async () => {
    process.argv = ["node", "eliza"];
    const program = makeProgram();
    await runHook(program, program);

    expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
    expect(updateNotifier.scheduleUpdateNotification).toHaveBeenCalledTimes(1);
  });

  it("still calls emitCliBanner when argv includes --json (preaction does not skip it)", async () => {
    process.argv = ["node", "eliza", "start", "--json"];
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);

    expect(banner.emitCliBanner).toHaveBeenCalledWith(PROGRAM_VERSION);
  });

  it("sets verbose from --verbose and does not assign NODE_NO_WARNINGS", async () => {
    process.argv = ["node", "eliza", "start", "--verbose"];
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);

    expect(isVerbose()).toBe(true);
    expect(process.env.NODE_NO_WARNINGS).toBeUndefined();
  });

  it("treats --debug as verbose because the hook passes includeDebug", async () => {
    process.argv = ["node", "eliza", "start", "--debug"];
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);

    expect(isVerbose()).toBe(true);
    expect(process.env.NODE_NO_WARNINGS).toBeUndefined();
  });

  it("does not treat --verbose after -- as a verbose flag", async () => {
    process.argv = ["node", "eliza", "start", "--", "--verbose"];
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);

    expect(isVerbose()).toBe(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
  });

  it("silences node warnings when not verbose and NODE_NO_WARNINGS is unset", async () => {
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);
    expect(isVerbose()).toBe(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
  });

  it("does not overwrite an existing NODE_NO_WARNINGS value", async () => {
    process.env.NODE_NO_WARNINGS = "0";
    const program = makeProgram();
    const start = program.command("start");
    await runHook(program, start);
    expect(isVerbose()).toBe(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("0");
  });

  it("still applies verbose setup when the banner is hidden", async () => {
    process.argv = ["node", "eliza", "update", "--verbose"];
    const program = makeProgram();
    const update = program.command("update");
    await runHook(program, update);

    expect(banner.emitCliBanner).not.toHaveBeenCalled();
    expect(isVerbose()).toBe(true);
    expect(process.env.NODE_NO_WARNINGS).toBeUndefined();
  });
});
