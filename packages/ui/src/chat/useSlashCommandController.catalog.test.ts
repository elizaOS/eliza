// @vitest-environment jsdom

/**
 * Catalog-load contract for useSlashCommandController (#11112).
 *
 * The slash menu only mounts when the controller's merged `commands` are
 * non-empty, so this pins the engine-agnostic contract behind it: whenever the
 * catalog fetch resolves with commands, `commands` resolve — with the default
 * (trusted dashboard) auth context keeping requiresAuth / requiresElevated
 * commands visible — and a FAILED fetch degrades to an empty catalog while
 * surfacing the error instead of silently swallowing it (a swallowed error is
 * indistinguishable from a genuinely empty catalog).
 */

import type { CustomActionDef } from "@elizaos/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandSurface,
  SlashCommandCatalogItem,
} from "../api/client-types-commands";

const { listCommands, listCustomActions } = vi.hoisted(() => ({
  listCommands:
    vi.fn<(surface?: string) => Promise<SlashCommandCatalogItem[]>>(),
  listCustomActions: vi.fn<() => Promise<CustomActionDef[]>>(),
}));

vi.mock("../api", () => ({
  client: {
    listCommands: (surface?: string) => listCommands(surface),
    listCustomActions: () => listCustomActions(),
  },
}));
vi.mock("../config/boot-config-react.hooks", () => ({
  useBootConfig: (): { shortcutFlags?: { naturalLanguage?: boolean } } => ({}),
}));
vi.mock("../hooks/useAvailableViews", () => ({
  useAvailableViews: (): { views: never[] } => ({ views: [] }),
}));
vi.mock("../state", () => ({
  useAppSelectorShallow: <T>(
    selector: (state: {
      setTab: (tab: string) => void;
      handleChatClear: () => Promise<void>;
    }) => T,
  ): T =>
    selector({
      setTab: () => {},
      handleChatClear: async () => {},
    }),
}));

import { useSlashCommandController } from "./useSlashCommandController";

function cmd(
  partial: Partial<SlashCommandCatalogItem> & { key: string },
): SlashCommandCatalogItem {
  return {
    nativeName: partial.key,
    description: "",
    textAliases: [`/${partial.key}`],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
    ...partial,
  };
}

const GUI: CommandSurface = "gui";

beforeEach(() => {
  listCommands.mockReset();
  listCustomActions.mockReset();
  listCustomActions.mockResolvedValue([]);
  window.localStorage.clear();
});

describe("useSlashCommandController — catalog load (#11112)", () => {
  it("resolves commands whenever the catalog fetch resolves, keeping auth-gated commands under the trusted-dashboard defaults", async () => {
    listCommands.mockResolvedValue([
      cmd({
        key: "settings",
        target: { kind: "navigate", tab: "settings", path: "/settings" },
      }),
      cmd({ key: "clear", requiresAuth: true }),
      cmd({ key: "admin", requiresElevated: true }),
    ]);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listCommands).toHaveBeenCalledWith(GUI);
    expect(result.current.commands.map((c) => c.key)).toEqual([
      "settings",
      "clear",
      "admin",
    ]);
  });

  it("still hides auth-gated commands for an unauthorized sender", async () => {
    listCommands.mockResolvedValue([
      cmd({ key: "open", requiresAuth: false }),
      cmd({ key: "clear", requiresAuth: true }),
      cmd({ key: "admin", requiresElevated: true }),
    ]);

    const { result } = renderHook(() =>
      useSlashCommandController({ isAuthorized: false, isElevated: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands.map((c) => c.key)).toEqual(["open"]);
  });

  it("an empty catalog resolves to no commands without any error (the menu simply never mounts)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listCommands.mockResolvedValue([]);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("a failed catalog fetch degrades to an empty catalog AND surfaces the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const failure = new Error("catalog fetch failed");
    listCommands.mockRejectedValue(failure);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[useSlashCommandController]"),
      failure,
    );
    consoleError.mockRestore();
  });

  it("a failed custom-actions fetch surfaces the error but keeps the server catalog", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listCommands.mockResolvedValue([cmd({ key: "settings" })]);
    const failure = new Error("custom actions fetch failed");
    listCustomActions.mockRejectedValue(failure);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands.map((c) => c.key)).toEqual(["settings"]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[useSlashCommandController]"),
      failure,
    );
    consoleError.mockRestore();
  });
});
