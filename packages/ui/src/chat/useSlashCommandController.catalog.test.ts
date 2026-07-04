// @vitest-environment jsdom

/**
 * Catalog-load contract for useSlashCommandController (#11112).
 *
 * The slash menu only mounts when the controller's merged `commands` are
 * non-empty, so this pins the engine-agnostic contract behind it: whenever the
 * catalog fetch resolves with commands, `commands` resolve — with the default
 * auth context now FAIL-CLOSED (#12087 Item 20), so requiresAuth /
 * requiresElevated commands are hidden unless the caller passes the sender's
 * real authority — and a FAILED fetch degrades to an empty catalog while
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
    source: partial.source ?? "builtin",
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
  it("resolves commands whenever the catalog fetch resolves, hiding auth-gated commands under the fail-closed defaults (#12087 Item 20)", async () => {
    listCommands.mockResolvedValue([
      cmd({
        key: "settings",
        target: { kind: "navigate", tab: "settings", path: "/settings" },
      }),
      cmd({ key: "clear", requiresAuth: true }),
      cmd({ key: "admin", requiresElevated: true }),
    ]);

    // No options → fail-closed: only the unconstrained command is visible.
    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listCommands).toHaveBeenCalledWith(GUI);
    expect(result.current.commands.map((c) => c.key)).toEqual(["settings"]);
    expect(result.current.isAuthorized).toBe(false);
    expect(result.current.isElevated).toBe(false);
  });

  it("shows auth- and elevation-gated commands once the caller passes the sender's authority (#12087 Item 20)", async () => {
    listCommands.mockResolvedValue([
      cmd({
        key: "settings",
        target: { kind: "navigate", tab: "settings", path: "/settings" },
      }),
      cmd({ key: "clear", requiresAuth: true }),
      cmd({ key: "admin", requiresElevated: true }),
    ]);

    const { result } = renderHook(() =>
      useSlashCommandController({ isAuthorized: true, isElevated: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
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
    expect(result.current.error).toBe(false);
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
    // #12784 three-state: a failed load must be distinguishable from a genuine
    // empty catalog — `error` is true, not a silent healthy-empty.
    expect(result.current.error).toBe(true);
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
    // Partial/degraded load: server catalog rendered, but the failed
    // custom-actions fetch still raises the error flag (#12784) so the surface
    // does not imply a complete catalog.
    expect(result.current.error).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[useSlashCommandController]"),
      failure,
    );
    consoleError.mockRestore();
  });

  it("a fully successful load leaves error false even when the catalog is non-empty", async () => {
    listCommands.mockResolvedValue([cmd({ key: "settings" })]);
    listCustomActions.mockResolvedValue([]);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands.map((c) => c.key)).toEqual(["settings"]);
    // Healthy load must NEVER set the error flag (no false-positive degrade).
    expect(result.current.error).toBe(false);
  });

  it("both fetches failing surfaces the error with an empty catalog (not a false healthy-empty)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listCommands.mockRejectedValue(new Error("catalog down"));
    listCustomActions.mockRejectedValue(new Error("custom down"));

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toEqual([]);
    expect(result.current.error).toBe(true);
    consoleError.mockRestore();
  });
});
