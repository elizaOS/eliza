/**
 * Covers registerPreActionHooks in ./preaction.ts: the Commander `preAction`
 * hook it installs must set the process title from the top-level command, emit
 * the banner and schedule the update check for ordinary commands, and skip both
 * for `--help`/`--version`, the update/completion commands, and
 * `ELIZA_HIDE_BANNER`. The hook's collaborators (argv parsing, banner,
 * globals, update notifier) are mocked so the assertions are about the hook's
 * own branching; the hook itself is the real exported implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTruthyEnvValue: vi.fn(() => false),
  setVerbose: vi.fn(),
  getCommandPath: vi.fn((): string[] => []),
  getVerboseFlag: vi.fn(() => false),
  hasHelpOrVersion: vi.fn(() => false),
  emitCliBanner: vi.fn(),
  resolveCliName: vi.fn(() => "eliza"),
  scheduleUpdateNotification: vi.fn(),
}));

vi.mock("@elizaos/shared", () => ({
  isTruthyEnvValue: (...a: unknown[]) => mocks.isTruthyEnvValue(...a),
}));
vi.mock("../../utils/globals", () => ({
  setVerbose: (...a: unknown[]) => mocks.setVerbose(...a),
}));
vi.mock("../argv", () => ({
  getCommandPath: (...a: unknown[]) => mocks.getCommandPath(...a),
  getVerboseFlag: (...a: unknown[]) => mocks.getVerboseFlag(...a),
  hasHelpOrVersion: (...a: unknown[]) => mocks.hasHelpOrVersion(...a),
}));
vi.mock("../banner", () => ({
  emitCliBanner: (...a: unknown[]) => mocks.emitCliBanner(...a),
}));
vi.mock("../cli-name", () => ({
  resolveCliName: (...a: unknown[]) => mocks.resolveCliName(...a),
}));
vi.mock("../../services/update-notifier", () => ({
  scheduleUpdateNotification: (...a: unknown[]) =>
    mocks.scheduleUpdateNotification(...a),
}));

type PreActionHook = (
  thisCommand: unknown,
  actionCommand: unknown,
) => Promise<void>;

describe("registerPreActionHooks", () => {
  let hookFn: PreActionHook;
  let originalTitle: string;

  beforeEach(async () => {
    vi.resetModules();
    mocks.hasHelpOrVersion.mockReset().mockReturnValue(false);
    mocks.getCommandPath.mockReset().mockReturnValue([]);
    mocks.getVerboseFlag.mockReset().mockReturnValue(false);
    mocks.isTruthyEnvValue.mockReset().mockReturnValue(false);
    mocks.resolveCliName.mockReset().mockReturnValue("eliza");
    mocks.scheduleUpdateNotification.mockReset();
    mocks.emitCliBanner.mockReset();
    mocks.setVerbose.mockReset();
    originalTitle = process.title;

    const mod = await import("./preaction.ts");
    const program = {
      hook: vi.fn((_name: string, fn: PreActionHook) => {
        hookFn = fn;
      }),
    };
    mod.registerPreActionHooks(program as never, "1.0.0");
    expect(program.hook).toHaveBeenCalledWith(
      "preAction",
      expect.any(Function),
    );
  });

  afterEach(() => {
    process.title = originalTitle;
  });

  function mockActionCommand(name = "chat") {
    return { name: vi.fn(() => name), parent: { parent: null } };
  }

  it("emits the banner and schedules the update check for an ordinary command", async () => {
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).toHaveBeenCalledWith("1.0.0");
    expect(mocks.scheduleUpdateNotification).toHaveBeenCalledTimes(1);
  });

  it("sets the process title from the top-level command name", async () => {
    await hookFn({}, mockActionCommand("start"));
    expect(process.title).toBe("eliza-start");
  });

  it("leaves the process title alone when the command is the CLI itself", async () => {
    const before = process.title;
    await hookFn({}, mockActionCommand("eliza"));
    expect(process.title).toBe(before);
  });

  it("resolves the verbose flag and silences node warnings when not verbose", async () => {
    const hadNoWarnings = process.env.NODE_NO_WARNINGS;
    delete process.env.NODE_NO_WARNINGS;
    try {
      await hookFn({}, mockActionCommand());
      expect(mocks.setVerbose).toHaveBeenCalledWith(false);
      expect(process.env.NODE_NO_WARNINGS).toBe("1");
    } finally {
      if (hadNoWarnings === undefined) delete process.env.NODE_NO_WARNINGS;
      else process.env.NODE_NO_WARNINGS = hadNoWarnings;
    }
  });

  it("skips everything when help/version is in argv", async () => {
    mocks.hasHelpOrVersion.mockReturnValue(true);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it("skips the banner for the update command", async () => {
    mocks.getCommandPath.mockReturnValue(["update"]);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
  });

  it("skips the banner for the completion command", async () => {
    mocks.getCommandPath.mockReturnValue(["completion"]);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
  });

  it("skips the banner when ELIZA_HIDE_BANNER is set", async () => {
    mocks.isTruthyEnvValue.mockReturnValue(true);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
    // The hook still resolves verbosity once the banner branch is skipped.
    expect(mocks.setVerbose).toHaveBeenCalledWith(false);
  });
});
