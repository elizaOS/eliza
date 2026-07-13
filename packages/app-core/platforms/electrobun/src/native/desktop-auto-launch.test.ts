/**
 * DesktopManager auto-launch artifact behavior (setAutoLaunch /
 * getAutoLaunchStatus) against a temp HOME: the macOS LaunchAgent plist and
 * Linux autostart .desktop are written/removed for real on disk, launchctl and
 * Windows `reg` invocations are captured through a recording Bun.spawn stub
 * (Vitest runs under Node, so the real Bun global is absent), and the Windows
 * path asserts the exact registry command construction since `reg` cannot run
 * on a POSIX host. This is the onboarding auto-start step's backing store —
 * the same RPC (`desktopSetAutoLaunch`) the first-run conductor and the
 * Settings toggle both call.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrandConfig } from "../brand-config";
import { DesktopManager, resetDesktopManagerForTesting } from "./desktop";

vi.mock("@elizaos/core", () => ({
  clearWorkspaceFolderConfig: vi.fn(),
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  writeWorkspaceFolderConfig: vi.fn(),
}));

vi.mock("./mac-window-effects", () => ({
  createSecurityScopedBookmark: vi.fn(() => null),
  isAppActive: vi.fn(() => false),
  isKeyWindow: vi.fn(() => false),
  makeKeyAndOrderFront: vi.fn(),
  orderOut: vi.fn(),
  startAccessingSecurityScopedBookmark: vi.fn(() => false),
  stopAccessingSecurityScopedBookmarks: vi.fn(),
  enableVibrancy: vi.fn(() => false),
  ensureShadow: vi.fn(() => false),
  setNativeDragRegion: vi.fn(),
  setTrafficLightsPosition: vi.fn(),
}));

vi.mock("electrobun/bun", () => {
  const events = { on: vi.fn(), off: vi.fn() };
  return {
    default: { events },
    BrowserWindow: vi.fn(),
    BrowserView: vi.fn(),
    BuildConfig: { get: vi.fn(async () => ({})) },
    ContextMenu: { on: vi.fn() },
    GlobalShortcut: {
      isRegistered: vi.fn(() => false),
      register: vi.fn(),
      unregister: vi.fn(),
      unregisterAll: vi.fn(),
    },
    Screen: {
      getAllDisplays: vi.fn(() => []),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1280, height: 800 },
      })),
    },
    Session: { defaultSession: {} },
    Tray: vi.fn(),
    Updater: {},
    Utils: {
      quit: vi.fn(),
      showNotification: vi.fn(),
      clipboard: {},
      openExternal: vi.fn(),
      // desktop.ts reads Utils.paths.* at module scope (PATH_NAME_MAP).
      paths: {
        home: "/tmp",
        appData: "/tmp",
        userData: "/tmp",
        userCache: "/tmp",
        userLogs: "/tmp",
        temp: "/tmp",
        cache: "/tmp",
        logs: "/tmp",
        config: "/tmp",
        documents: "/tmp",
        downloads: "/tmp",
        desktop: "/tmp",
        pictures: "/tmp",
        music: "/tmp",
        videos: "/tmp",
      },
      setDockIconVisible: vi.fn(),
      isDockIconVisible: vi.fn(() => true),
    },
  };
});

interface RecordedSpawn {
  cmd: string[];
  options: unknown;
}

/**
 * Recording Bun.spawn stub. `stdoutQueue` entries feed successive spawns'
 * stdout (consumed by `new Response(proc.stdout).text()` on the Windows query
 * path); when empty, stdout is "".
 */
const spawnRecorder = {
  calls: [] as RecordedSpawn[],
  stdoutQueue: [] as string[],
  throwOnNext: false,
  reset() {
    this.calls = [];
    this.stdoutQueue = [];
    this.throwOnNext = false;
  },
};

const originalBun = (globalThis as { Bun?: unknown }).Bun;
const originalHome = process.env.HOME;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) as PropertyDescriptor;

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

let tempHome: string;

beforeEach(() => {
  resetDesktopManagerForTesting();
  spawnRecorder.reset();
  (globalThis as { Bun?: unknown }).Bun = {
    spawn(cmd: string[], options: unknown) {
      if (spawnRecorder.throwOnNext) {
        spawnRecorder.throwOnNext = false;
        throw new Error("spawn unavailable");
      }
      spawnRecorder.calls.push({ cmd, options });
      return {
        exited: Promise.resolve(0),
        stdout: spawnRecorder.stdoutQueue.shift() ?? "",
        stderr: "",
      };
    },
  };
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-autolaunch-home-"));
  process.env.HOME = tempHome;
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
  (globalThis as { Bun?: unknown }).Bun = originalBun;
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
  resetDesktopManagerForTesting();
});

function macPlistPath(): string {
  return path.join(
    tempHome,
    "Library",
    "LaunchAgents",
    getBrandConfig().macLaunchAgentPlist,
  );
}

function linuxDesktopPath(): string {
  return path.join(
    tempHome,
    ".config",
    "autostart",
    getBrandConfig().linuxDesktopFileName,
  );
}

describe("macOS LaunchAgent plist", () => {
  beforeEach(() => {
    setProcessPlatform("darwin");
  });

  it("enable writes the plist with the brand label, the app path, RunAtLoad, and no --hidden; launchctl loads it", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true });

    const plist = macPlistPath();
    expect(fs.existsSync(plist)).toBe(true);
    const content = fs.readFileSync(plist, "utf8");
    expect(content).toContain(
      `<string>${getBrandConfig().macLaunchAgentLabel}</string>`,
    );
    expect(content).toContain(`<string>${process.execPath}</string>`);
    expect(content).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(content).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(content).not.toContain("--hidden");

    expect(spawnRecorder.calls).toHaveLength(1);
    expect(spawnRecorder.calls[0]?.cmd).toEqual(["launchctl", "load", plist]);

    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: true,
      openAsHidden: false,
    });
  });

  it("openAsHidden adds the --hidden program argument and the status reflects it", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true, openAsHidden: true });

    const content = fs.readFileSync(macPlistPath(), "utf8");
    expect(content).toContain("<string>--hidden</string>");

    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: true,
      openAsHidden: true,
    });
  });

  it("disable unloads via launchctl and removes the plist", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true });
    spawnRecorder.calls = [];

    await manager.setAutoLaunch({ enabled: false });

    expect(fs.existsSync(macPlistPath())).toBe(false);
    expect(spawnRecorder.calls).toHaveLength(1);
    expect(spawnRecorder.calls[0]?.cmd).toEqual([
      "launchctl",
      "unload",
      macPlistPath(),
    ]);
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });

  it("disable with no plist present is a clean no-op (no launchctl churn)", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: false });
    expect(spawnRecorder.calls).toHaveLength(0);
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });
});

describe("Linux autostart .desktop", () => {
  beforeEach(() => {
    setProcessPlatform("linux");
  });

  it("enable writes the .desktop entry with the brand name, Exec app path, and autostart flag — no subprocesses", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true });

    const desktopFile = linuxDesktopPath();
    expect(fs.existsSync(desktopFile)).toBe(true);
    const content = fs.readFileSync(desktopFile, "utf8");
    expect(content).toContain("[Desktop Entry]");
    expect(content).toContain(`Name=${getBrandConfig().linuxDesktopEntryName}`);
    expect(content).toContain(`Exec=${process.execPath}\n`);
    expect(content).toContain("X-GNOME-Autostart-enabled=true");
    expect(spawnRecorder.calls).toHaveLength(0);

    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: true,
      openAsHidden: false,
    });
  });

  it("openAsHidden appends --hidden to Exec and the status reflects it", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true, openAsHidden: true });

    const content = fs.readFileSync(linuxDesktopPath(), "utf8");
    expect(content).toContain(`Exec=${process.execPath} --hidden`);
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: true,
      openAsHidden: true,
    });
  });

  it("disable removes the .desktop file", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true });
    await manager.setAutoLaunch({ enabled: false });

    expect(fs.existsSync(linuxDesktopPath())).toBe(false);
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });
});

describe("Windows HKCU Run registry commands", () => {
  const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

  beforeEach(() => {
    setProcessPlatform("win32");
  });

  it("enable constructs `reg add` with the brand value name, REG_SZ, and the app path", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true });

    expect(spawnRecorder.calls).toHaveLength(1);
    expect(spawnRecorder.calls[0]?.cmd).toEqual([
      "reg",
      "add",
      RUN_KEY,
      "/v",
      getBrandConfig().windowsRegistryValueName,
      "/t",
      "REG_SZ",
      "/d",
      process.execPath,
      "/f",
    ]);
  });

  it("openAsHidden appends --hidden to the registry value data", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: true, openAsHidden: true });

    expect(spawnRecorder.calls[0]?.cmd).toContain(
      `${process.execPath} --hidden`,
    );
  });

  it("disable constructs `reg delete` for the brand value name", async () => {
    const manager = new DesktopManager();
    await manager.setAutoLaunch({ enabled: false });

    expect(spawnRecorder.calls).toHaveLength(1);
    expect(spawnRecorder.calls[0]?.cmd).toEqual([
      "reg",
      "delete",
      RUN_KEY,
      "/v",
      getBrandConfig().windowsRegistryValueName,
      "/f",
    ]);
  });

  it("status parses `reg query` output: value present + --hidden", async () => {
    const valueName = getBrandConfig().windowsRegistryValueName;
    spawnRecorder.stdoutQueue.push(
      `\r\n${RUN_KEY}\r\n    ${valueName}    REG_SZ    C:\\eliza\\eliza.exe --hidden\r\n`,
    );
    const manager = new DesktopManager();
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: true,
      openAsHidden: true,
    });
    expect(spawnRecorder.calls[0]?.cmd).toEqual([
      "reg",
      "query",
      RUN_KEY,
      "/v",
      valueName,
    ]);
  });

  it("status reads disabled when the query output lacks the value name", async () => {
    spawnRecorder.stdoutQueue.push("ERROR: The system was unable to find...");
    const manager = new DesktopManager();
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });

  it("status reads disabled when reg cannot be spawned at all", async () => {
    spawnRecorder.throwOnNext = true;
    const manager = new DesktopManager();
    await expect(manager.getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });
});
