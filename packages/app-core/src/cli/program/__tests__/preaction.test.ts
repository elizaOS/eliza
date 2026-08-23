import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTruthyEnvValue: vi.fn(() => false),
  setVerbose: vi.fn(),
  getCommandPath: vi.fn(() => []),
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
vi.mock("@elizaos/agent", () => ({
  checkForUpdate: vi.fn(),
  loadElizaConfig: vi.fn(() => ({})),
  resolveChannel: vi.fn(),
}));

describe("registerPreActionHooks", () => {
  let hookFn: (a: unknown, b: unknown) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mocks.hasHelpOrVersion.mockReset().mockReturnValue(false);
    mocks.getCommandPath.mockReset().mockReturnValue([]);
    mocks.getVerboseFlag.mockReset().mockReturnValue(false);
    mocks.isTruthyEnvValue.mockReset().mockReturnValue(false);
    mocks.scheduleUpdateNotification.mockReset();
    mocks.emitCliBanner.mockReset();
    const mod = await import("./preaction.ts");
    const program = {
      hook: vi.fn(
        (_name: string, fn: (a: unknown, b: unknown) => Promise<void>) => {
          hookFn = fn;
        },
      ),
    };
    mod.registerPreActionHooks(program as never, "1.0.0");
    expect(program.hook).toHaveBeenCalledWith(
      "preAction",
      expect.any(Function),
    );
  });

  function mockActionCommand(name = "chat") {
    return { name: vi.fn(() => name), parent: { parent: null } };
  }

  it("emits banner and loads update notifier safely", async () => {
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).toHaveBeenCalledWith("1.0.0");
    // 动态 import 的 update-notifier 在非 TTY 环境安全早退（不抛错）
  });

  it("skips banner when help/version is in argv", async () => {
    mocks.hasHelpOrVersion.mockReturnValue(true);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
  });

  it("skips banner for update/completion commands", async () => {
    mocks.getCommandPath.mockReturnValue(["update"]);
    await hookFn({}, mockActionCommand());
    expect(mocks.emitCliBanner).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateNotification).not.toHaveBeenCalled();
  });
});
