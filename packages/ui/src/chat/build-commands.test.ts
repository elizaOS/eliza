/**
 * Unit coverage for slash-command list assembly from the view registry, gated by
 * enabled view kinds. Pure functions, no live agent.
 */
import type { EnabledViewKinds } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../hooks/useAvailableViews";
import {
  type BuildCommandsArgs,
  buildCommands,
  paletteViewEntries,
  type ViewNavEntry,
} from ".";

function args(over: Partial<BuildCommandsArgs> = {}): BuildCommandsArgs {
  return {
    agentState: "running",
    activeGameViewerUrl: "",
    handleStart: vi.fn(),
    handleStop: vi.fn(),
    handleRestart: vi.fn(),
    navigateTab: vi.fn(),
    navigateView: vi.fn(),
    views: [],
    setAppsSubTab: vi.fn(),
    loadPlugins: vi.fn(),
    loadSkills: vi.fn(),
    loadLogs: vi.fn(),
    loadWorkbench: vi.fn(),
    openBugReport: vi.fn(),
    desktopRuntime: false,
    focusDesktopMainWindow: vi.fn(),
    openDesktopWorkspaceWindow: vi.fn(),
    openDesktopSettingsWindow: vi.fn(),
    openDesktopSurfaceWindow: vi.fn(),
    ...over,
  };
}

describe("buildCommands — palette launcher (#8792)", () => {
  it("never exposes a conversation reset in the one-thread product", () => {
    const commands = buildCommands(args());
    expect(commands.some((command) => command.id === "chat-clear")).toBe(false);
    expect(
      commands.some((command) => /clear chat|new chat/i.test(command.label)),
    ).toBe(false);
  });

  it("opens Desktop Workspace through the full managed-shell launcher", () => {
    const openDesktopWorkspaceWindow = vi.fn();
    const openDesktopSettingsWindow = vi.fn();
    const commands = buildCommands(
      args({
        desktopRuntime: true,
        openDesktopWorkspaceWindow,
        openDesktopSettingsWindow,
      }),
    );

    commands
      .find((command) => command.id === "desktop-open-workspace")
      ?.action();

    expect(openDesktopWorkspaceWindow).toHaveBeenCalledOnce();
    expect(openDesktopSettingsWindow).not.toHaveBeenCalled();
  });

  it("navigates built-in tabs through navigateTab (which reports VIEW_SWITCHED)", () => {
    const navigateTab = vi.fn();
    const commands = buildCommands(args({ navigateTab }));
    const wallet = commands.find((c) => c.label === "Open Wallet");
    expect(wallet).toBeTruthy();
    wallet?.action();
    expect(navigateTab).toHaveBeenCalledWith("inventory");

    // Coverage extended well beyond the original 10 tabs.
    expect(commands.some((c) => c.label === "Open Messages")).toBe(true);
    expect(commands.some((c) => c.label === "Open Projects")).toBe(true);
    expect(commands.some((c) => c.label === "Open Automations")).toBe(true);
    expect(commands.some((c) => c.label === "Open Browser")).toBe(true);
  });

  it("exposes every registered view as a launcher entry via navigateView", () => {
    const navigateView = vi.fn();
    const views: ViewNavEntry[] = [
      { id: "inbox", label: "Inbox", path: "/views/inbox" },
      { id: "calendar", label: "Calendar", path: "/views/calendar" },
    ];
    const commands = buildCommands(args({ navigateView, views }));
    const inbox = commands.find((c) => c.label === "Open Inbox");
    expect(inbox).toBeTruthy();
    inbox?.action();
    expect(navigateView).toHaveBeenCalledWith("inbox", "/views/inbox");
    expect(commands.some((c) => c.label === "Open Calendar")).toBe(true);
  });

  it("dedupes a registered view against a built-in tab of the same label", () => {
    const views: ViewNavEntry[] = [
      { id: "wallet.inventory", label: "Wallet", path: "/wallet" },
    ];
    const commands = buildCommands(args({ views }));
    const wallets = commands.filter((c) => c.label === "Open Wallet");
    expect(wallets).toHaveLength(1);
    // The built-in tab wins (navigateTab, not navigateView).
    expect(
      commands.find((c) => c.id === "view-wallet.inventory"),
    ).toBeUndefined();
  });
});

describe("paletteViewEntries — visibility gate (#8792)", () => {
  function view(over: Partial<ViewRegistryEntry>): ViewRegistryEntry {
    return {
      id: "x",
      label: "X",
      available: true,
      pluginName: "p",
      ...over,
    } as ViewRegistryEntry;
  }
  const off: EnabledViewKinds = { developer: false, preview: false };
  const on: EnabledViewKinds = { developer: true, preview: true };

  it("includes a normal release GUI view", () => {
    const out = paletteViewEntries(
      [view({ id: "inbox", label: "Inbox" })],
      off,
    );
    expect(out).toEqual([{ id: "inbox", label: "Inbox", path: undefined }]);
  });

  it("hides developer views unless developer mode is on", () => {
    const dev = [view({ id: "vector-browser", developerOnly: true })];
    expect(paletteViewEntries(dev, off)).toHaveLength(0);
    expect(paletteViewEntries(dev, on)).toHaveLength(1);
  });

  it("hides internal (visibleInManager:false), unavailable, and non-GUI views", () => {
    expect(
      paletteViewEntries([view({ visibleInManager: false })], off),
    ).toHaveLength(0);
    expect(paletteViewEntries([view({ available: false })], off)).toHaveLength(
      0,
    );
    expect(paletteViewEntries([view({ viewType: "tui" })], off)).toHaveLength(
      0,
    );
  });
});
