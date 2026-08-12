/** Verifies the native permission Settings handoff, including macOS compatibility fallback and observable failures. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeNotifications = vi.hoisted(() => ({
  check: vi.fn<() => number | null>(),
  request: vi.fn<() => number | null>(),
}));

vi.mock("./agent", () => ({
  resolveRuntimeDistPath: () => "/tmp/eliza-permissions-test-runtime",
}));

vi.mock("./mac-window-effects", () => ({
  checkNotificationPermission: nativeNotifications.check,
  requestNotificationPermission: nativeNotifications.request,
}));

import {
  buildPermissionSettingsCommand,
  PermissionManager,
  runSettingsCommand,
  waitForNativeNotificationStatus,
} from "./permissions";

function settingsProcess(exitCode: number, stderr = "") {
  return {
    exited: Promise.resolve(exitCode),
    stderr: new Blob([stderr]).stream(),
  };
}

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describe("permission Settings commands", () => {
  it.each([
    ["check", -2],
    ["request", 0],
  ] as const)(
    "times out a pending notification %s",
    async (operation, status) => {
      vi.useFakeTimers();
      const pending = waitForNativeNotificationStatus(status, () => status, {
        operation,
        timeoutMs: 500,
        pollIntervalMs: 250,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
        context: { operation, timeoutMs: 500 },
      });
      await vi.advanceTimersByTimeAsync(750);
      await rejection;
      vi.useRealTimers();
    },
  );

  it("uses a detached Linux handoff rather than waiting for the Settings window", () => {
    expect(buildPermissionSettingsCommand("notifications", "linux")).toEqual([
      "sh",
      "-lc",
      'command -v gnome-control-center >/dev/null || exit 127; nohup gnome-control-center "$1" >/dev/null 2>&1 &',
      "eliza-settings",
      "notifications",
    ]);
  });

  it("surfaces a missing Linux Settings launcher", async () => {
    await expect(
      runSettingsCommand(
        [
          "sh",
          "-lc",
          "command -v eliza-definitely-missing-settings >/dev/null || exit 127; nohup eliza-definitely-missing-settings >/dev/null 2>&1 &",
        ],
        () => settingsProcess(127, "launcher missing"),
      ),
    ).rejects.toThrow("Settings command exited 127");
  });

  it("uses the native Windows Settings URI handoff", () => {
    expect(buildPermissionSettingsCommand("microphone", "win32")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "ms-settings:privacy-microphone",
    ]);
  });
});

describeMac("PermissionManager macOS Settings handoff", () => {
  beforeEach(() => {
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    nativeNotifications.check.mockReset();
    nativeNotifications.request.mockReset();
    nativeNotifications.check.mockReturnValue(1);
    nativeNotifications.request.mockReturnValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the current Notifications settings extension", async () => {
    const spawn = vi
      .spyOn(Bun, "spawn")
      .mockReturnValue(
        settingsProcess(0) as unknown as ReturnType<typeof Bun.spawn>,
      );

    await new PermissionManager().openSettings("notifications");

    expect(spawn).toHaveBeenCalledWith(
      [
        "open",
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
  });

  it("reads Notifications from the signed Electrobun native host", async () => {
    nativeNotifications.check.mockReturnValue(1);

    await expect(
      new PermissionManager().checkPermission("notifications", true),
    ).resolves.toMatchObject({
      id: "notifications",
      status: "denied",
      canRequest: false,
      platform: "darwin",
    });
    expect(nativeNotifications.check).toHaveBeenCalledOnce();
  });

  it("requests Notifications through the signed Electrobun native host", async () => {
    nativeNotifications.request.mockReturnValue(2);

    await expect(
      new PermissionManager().requestPermission("notifications"),
    ).resolves.toMatchObject({
      id: "notifications",
      status: "granted",
      canRequest: false,
      platform: "darwin",
    });
    expect(nativeNotifications.request).toHaveBeenCalledOnce();
  });

  it("surfaces native notification configuration failures", async () => {
    nativeNotifications.check.mockReturnValue(-1);

    await expect(
      new PermissionManager().checkPermission("notifications", true),
    ).rejects.toMatchObject({ code: "NOTIFICATION_AUTHORIZATION_FAILED" });
  });

  it("falls back to the legacy Notifications pane when the current URI is unavailable", async () => {
    const spawn = vi
      .spyOn(Bun, "spawn")
      .mockReturnValueOnce(
        settingsProcess(1, "modern unavailable") as unknown as ReturnType<
          typeof Bun.spawn
        >,
      )
      .mockReturnValueOnce(
        settingsProcess(0) as unknown as ReturnType<typeof Bun.spawn>,
      );

    await new PermissionManager().openSettings("notifications");

    expect(spawn).toHaveBeenNthCalledWith(
      2,
      ["open", "x-apple.systempreferences:com.apple.preference.notifications"],
      { stdout: "ignore", stderr: "pipe" },
    );
  });

  it("rejects when neither Notifications pane can be opened", async () => {
    vi.spyOn(Bun, "spawn")
      .mockReturnValueOnce(
        settingsProcess(1, "modern unavailable") as unknown as ReturnType<
          typeof Bun.spawn
        >,
      )
      .mockReturnValueOnce(
        settingsProcess(1, "legacy unavailable") as unknown as ReturnType<
          typeof Bun.spawn
        >,
      );

    await expect(
      new PermissionManager().openSettings("notifications"),
    ).rejects.toThrow("Could not open macOS notification settings");
  });
});
