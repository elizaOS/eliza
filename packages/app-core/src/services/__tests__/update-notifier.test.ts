import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  loadElizaConfig: vi.fn(),
  resolveChannel: vi.fn((_config?: unknown) => "stable"),
  theme: {
    accent: vi.fn((t: string) => `a(${t})`),
    muted: vi.fn((t: string) => `m(${t})`),
    success: vi.fn((t: string) => `s(${t})`),
    command: vi.fn((t: string) => `c(${t})`),
  },
}));

vi.mock("@elizaos/agent", () => ({
  checkForUpdate: () => mocks.checkForUpdate(),
  loadElizaConfig: () => mocks.loadElizaConfig(),
  resolveChannel: (config?: unknown) => mocks.resolveChannel(config),
}));
vi.mock("@elizaos/shared", () => ({ theme: mocks.theme }));

describe("scheduleUpdateNotification", () => {
  let originalIsTTY: boolean | undefined;
  let originalCI: string | undefined;
  let mod: typeof import("../update-notifier.ts");

  beforeEach(async () => {
    vi.resetModules();
    mocks.checkForUpdate.mockReset();
    mocks.loadElizaConfig.mockReset();
    mocks.resolveChannel.mockReset();
    mocks.resolveChannel.mockReturnValue("stable");
    originalIsTTY = (process.stderr as { isTTY?: boolean }).isTTY;
    originalCI = process.env.CI;
    delete process.env.CI;
    mod = await import("../update-notifier.ts");
  });

  afterEach(() => {
    (process.stderr as { isTTY?: boolean }).isTTY = originalIsTTY;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  });

  function forceTTY(on: boolean) {
    (process.stderr as { isTTY?: boolean }).isTTY = on;
  }

  it("skips when checkOnStart is disabled", async () => {
    mocks.loadElizaConfig.mockReturnValue({ update: { checkOnStart: false } });
    forceTTY(true);
    mod.scheduleUpdateNotification();
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("skips in CI", async () => {
    mocks.loadElizaConfig.mockReturnValue({});
    process.env.CI = "true";
    mod.scheduleUpdateNotification();
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("writes an update notice when a newer version exists", async () => {
    mocks.loadElizaConfig.mockReturnValue({});
    forceTTY(true);
    mocks.checkForUpdate.mockResolvedValue({
      updateAvailable: true,
      latestVersion: "2.0.0",
      currentVersion: "1.0.0",
    });
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    mod.scheduleUpdateNotification();
    await new Promise((r) => setTimeout(r, 10));
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("Update available"),
    );
    write.mockRestore();
  });
});
