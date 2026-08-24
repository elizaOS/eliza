/** Verifies useSlashCommandController — merged-catalog composition, app-level side effects, and telemetry reporting guards through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Complements the catalog/models suites with the parts they do not reach: the
 * alias-merge precedence between the server catalog, saved commands
 * (localStorage) and enabled custom actions; the navigation side effects the
 * composer menu invokes (tab switch, settings/view/palette DOM events, chat
 * clear); and the fire-and-forget telemetry guards (#8792) — no fetch without
 * a configured API base or token, and a failed report POST degrades to a
 * logger.warn instead of breaking navigation.
 */

import type { CustomActionDef } from "@elizaos/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { SETTINGS_SECTION_SUGGESTIONS } from "../components/settings/settings-section-tokens";
import { NAVIGATE_VIEW_EVENT } from "../events";

vi.mock("../api", () => ({
  client: {
    getBaseUrl: () => "http://localhost:2138",
    listCommands: vi
      .fn<(surface?: string) => Promise<never[]>>()
      .mockResolvedValue([]),
    listCustomActions: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    getModelsCatalog: vi.fn(() =>
      Promise.reject(new Error("getModelsCatalog not expected in this suite")),
    ),
  },
}));
vi.mock("../state", () => {
  const setTab = vi.fn<(tab: string) => void>();
  const handleChatClear = vi.fn<() => Promise<void>>();
  function useAppSelectorShallow<T>(
    selector: (s: {
      setTab: typeof setTab;
      handleChatClear: typeof handleChatClear;
    }) => T,
  ): T {
    return selector({ setTab, handleChatClear });
  }
  return { useAppSelectorShallow, __spies: { setTab, handleChatClear } };
});
vi.mock("../hooks/useAvailableViews", () => {
  let views: Array<{ id: string }> = [];
  function useAvailableViews(): { views: Array<{ id: string }> } {
    return { views };
  }
  return {
    useAvailableViews,
    __setViews(next: Array<{ id: string }>): void {
      views = next;
    },
  };
});
vi.mock("../utils/eliza-globals", () => {
  let base = "http://localhost:2138";
  let token: string | null = "test-token";
  let failBaseRead = false;
  return {
    getElizaApiBase: () => {
      if (failBaseRead) throw new Error("base store unavailable");
      return base;
    },
    getElizaApiToken: () => token,
    setElizaApiBase: (next: string) => {
      base = next;
    },
    setElizaApiToken: (next: string | null) => {
      token = next;
    },
    clearElizaApiBase: () => {
      base = "";
    },
    clearElizaApiToken: () => {
      token = null;
    },
    __setGlobals(next: {
      base?: string;
      token?: string | null;
      failBaseRead?: boolean;
    }): void {
      if (next.base !== undefined) base = next.base;
      if (next.token !== undefined) token = next.token;
      if (next.failBaseRead !== undefined) failBaseRead = next.failBaseRead;
    },
  };
});

import { CUSTOM_COMMANDS_STORAGE_KEY } from "./index";
import { useSlashCommandController } from "./useSlashCommandController";

const stateNs = (await import("../state")) as unknown as {
  __spies: {
    setTab: ReturnType<typeof vi.fn<(tab: string) => void>>;
    handleChatClear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
};
const viewsNs = (await import("../hooks/useAvailableViews")) as unknown as {
  __setViews: (next: Array<{ id: string }>) => void;
};
const globalsNs = (await import("../utils/eliza-globals")) as unknown as {
  __setGlobals: (next: {
    base?: string;
    token?: string | null;
    failBaseRead?: boolean;
  }) => void;
};

const listCommands = vi.mocked(client.listCommands);
const listCustomActions = vi.mocked(client.listCustomActions);

import { logger } from "@elizaos/logger";
import type { SlashCommandCatalogItem } from "../api/client-types-commands";

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

function customAction(
  partial: Partial<CustomActionDef> & { name: string },
): CustomActionDef {
  const { name, ...rest } = partial;
  return {
    id: `action-${name.toLowerCase()}`,
    name,
    description: "",
    parameters: [],
    handler: { type: "shell", command: "echo hi" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  };
}

function seedSavedCommands(
  commands: Array<{ name: string; text: string }>,
): void {
  window.localStorage.setItem(
    CUSTOM_COMMANDS_STORAGE_KEY,
    JSON.stringify(
      commands.map((c, i) => ({ ...c, createdAt: 1700000000000 + i })),
    ),
  );
}

async function renderLoadedController(
  options?: Parameters<typeof useSlashCommandController>[0],
) {
  const harness = renderHook(() => useSlashCommandController(options));
  await waitFor(() => expect(harness.result.current.loading).toBe(false));
  return harness;
}

function lastFetchCall(): [string, RequestInit] {
  expect(fetchMock).toHaveBeenCalled();
  return fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
}

const fetchMock =
  vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();

beforeEach(() => {
  listCommands.mockReset().mockResolvedValue([]);
  listCustomActions.mockReset().mockResolvedValue([]);
  stateNs.__spies.setTab.mockClear();
  stateNs.__spies.handleChatClear.mockReset().mockResolvedValue(undefined);
  viewsNs.__setViews([]);
  globalsNs.__setGlobals({
    base: "http://localhost:2138",
    token: "test-token",
    failBaseRead: false,
  });
  window.localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSlashCommandController — merged catalog composition", () => {
  it("keeps the server definition on alias collisions and appends saved then custom commands in order", async () => {
    listCommands.mockResolvedValue([
      cmd({ key: "settings" }),
      cmd({ key: "help", textAliases: ["/Help"] }),
    ]);
    seedSavedCommands([
      { name: "/Deploy Prod", text: "deploy now" },
      // Normalizes to the same alias as the server's /settings command.
      { name: "settings", text: "open settings" },
    ]);
    listCustomActions.mockResolvedValue([
      customAction({ name: "HELP" }),
      customAction({ name: "Weather", enabled: true }),
      customAction({ name: "Echo", enabled: false }),
    ]);

    const { result } = await renderLoadedController();

    // Server first; colliding saved (/settings) and custom (/help) dropped;
    // disabled custom action excluded; locally-derived survivors keep their
    // group order (saved before custom actions).
    expect(result.current.commands.map((c) => c.key)).toEqual([
      "settings",
      "help",
      "saved:deploy prod",
      "custom-action:weather",
    ]);
    expect(result.current.commands[2].source).toBe("saved");
    expect(result.current.commands[3].source).toBe("custom-action");
    expect(result.current.error).toBe(false);
  });

  it("renders locally-derived saved and custom commands when the server catalog is empty", async () => {
    seedSavedCommands([{ name: "notes", text: "open notes" }]);
    listCustomActions.mockResolvedValue([customAction({ name: "Status" })]);

    const { result } = await renderLoadedController();

    expect(result.current.loading).toBe(false);
    expect(result.current.commands.map((c) => c.key)).toEqual([
      "saved:notes",
      "custom-action:status",
    ]);
    // A healthy empty SERVER catalog is not a degraded load.
    expect(result.current.error).toBe(false);
  });
});

describe("useSlashCommandController — app-level side effects", () => {
  it("navigateTab switches the shell tab and reports the surface without a path", async () => {
    const { result } = await renderLoadedController();

    act(() => result.current.navigateTab("inventory"));

    expect(stateNs.__spies.setTab).toHaveBeenCalledWith("inventory");
    const [url, init] = lastFetchCall();
    expect(url).toBe("http://localhost:2138/api/views/inventory/navigate");
    expect(init.method).toBe("POST");
    // No optional path key when none was provided.
    expect(JSON.parse(init.body as string)).toEqual({ source: "user" });
  });

  it("navigateSettings dispatches the settings event with the section and reports it as a settings view path", async () => {
    const { NAVIGATE_SETTINGS_EVENT } = await import(
      "./useSlashCommandController"
    );
    const seen: CustomEvent<{ section?: string }>[] = [];
    const listener = (e: Event): void => {
      seen.push(e as CustomEvent<{ section?: string }>);
    };
    window.addEventListener(NAVIGATE_SETTINGS_EVENT, listener);
    const { result } = await renderLoadedController();

    act(() => result.current.navigateSettings("appearance"));

    window.removeEventListener(NAVIGATE_SETTINGS_EVENT, listener);
    expect(seen).toHaveLength(1);
    expect(seen[0].detail.section).toBe("appearance");

    const [url, init] = lastFetchCall();
    expect(url).toBe("http://localhost:2138/api/views/settings/navigate");
    expect(JSON.parse(init.body as string)).toEqual({
      source: "user",
      path: "appearance",
    });
  });

  it("navigateView dispatches the view-navigation event and reports only when a viewId is present", async () => {
    const seen: CustomEvent[] = [];
    const listener = (e: Event): void => {
      seen.push(e as CustomEvent);
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    const { result } = await renderLoadedController();

    act(() =>
      result.current.navigateView({
        viewId: "wallet-view",
        viewPath: "/wallet",
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toMatchObject({
      viewId: "wallet-view",
      viewPath: "/wallet",
    });
    const [url, init] = lastFetchCall();
    expect(url).toBe("http://localhost:2138/api/views/wallet-view/navigate");
    expect(JSON.parse(init.body as string)).toEqual({
      source: "user",
      path: "/wallet",
    });

    // A bare deep-link (no viewId) still navigates but is never reported —
    // the reporter keys off the viewId guard.
    fetchMock.mockClear();
    act(() => result.current.navigateView({ viewPath: "/deep/link" }));

    expect(seen).toHaveLength(2);
    expect(seen[1].detail).toMatchObject({ viewPath: "/deep/link" });
    expect(fetchMock).not.toHaveBeenCalled();

    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

  it("clearChat delegates to the shell's chat-clear handler", async () => {
    const { result } = await renderLoadedController();

    act(() => result.current.clearChat());

    expect(stateNs.__spies.handleChatClear).toHaveBeenCalledTimes(1);
  });

  it("openCommandPalette dispatches the command palette event on the document", async () => {
    const { COMMAND_PALETTE_EVENT } = await import("../events");
    let fired = 0;
    const listener = (): void => {
      fired += 1;
    };
    document.addEventListener(COMMAND_PALETTE_EVENT, listener);
    const { result } = await renderLoadedController();

    act(() => result.current.openCommandPalette());

    document.removeEventListener(COMMAND_PALETTE_EVENT, listener);
    expect(fired).toBe(1);
  });

  it("keeps natural-language shortcuts disabled — slash protocol stays explicit", async () => {
    const { result } = await renderLoadedController();
    expect(result.current.naturalShortcutsEnabled).toBe(false);
  });
});

describe("useSlashCommandController — telemetry reporting guards (#8792)", () => {
  it("fires no report request when no API base is configured, without throwing", async () => {
    globalsNs.__setGlobals({ base: "" });
    const { result } = await renderLoadedController();

    expect(() => {
      act(() => result.current.navigateTab("inventory"));
      result.current.navigateSettings("appearance");
      act(() =>
        result.current.navigateView({ viewId: "wallet-view", viewPath: "/" }),
      );
    }).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits the Authorization header when no API token is configured", async () => {
    globalsNs.__setGlobals({ token: null });

    const { reportShortcutFired } = await import("./useSlashCommandController");
    reportShortcutFired("show-keyboard-shortcuts");

    const [, init] = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      shortcutId: "show-keyboard-shortcuts",
    });
  });

  it("degrades a non-ok report response to a logged warning for both reporters", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));

    const { reportShortcutFired, reportUserViewSwitch } = await import(
      "./useSlashCommandController"
    );
    expect(() => reportUserViewSwitch("wallet")).not.toThrow();
    expect(() => reportShortcutFired("toggle-terminal")).not.toThrow();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(2));
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(
      messages.find((m) => m.includes("view-switch report failed")),
    ).toBeTruthy();
    expect(
      messages.find((m) => m.includes("shortcut report failed")),
    ).toBeTruthy();
    expect(messages.join("\n")).toContain("500");
  });

  it("survives a synchronously failing API-base read without dispatching anything", async () => {
    globalsNs.__setGlobals({ failBaseRead: true });

    const { reportShortcutFired, reportUserViewSwitch } = await import(
      "./useSlashCommandController"
    );
    expect(() => reportUserViewSwitch("wallet")).not.toThrow();
    expect(() => reportShortcutFired("toggle-terminal")).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useSlashCommandController — choice resolution sources", () => {
  it("resolves view ids from the live registry and passes the settings suggestions through", async () => {
    viewsNs.__setViews([{ id: "wallet-view" }, { id: "notes-view" }]);
    const { result } = await renderLoadedController();

    expect(result.current.resolveChoices("views")).toEqual([
      "wallet-view",
      "notes-view",
    ]);
    // The completion source IS the shared suggestion list, not a copy.
    expect(result.current.resolveChoices("settings-sections")).toBe(
      SETTINGS_SECTION_SUGGESTIONS,
    );
    expect(SETTINGS_SECTION_SUGGESTIONS.length).toBeGreaterThan(0);
  });

  it("answers no completions for sources this controller does not wire", async () => {
    const { result } = await renderLoadedController();

    // No models catalog was fetched (no loaded command declares a models arg).
    expect(result.current.resolveChoices("models")).toEqual([]);
    expect(result.current.resolveChoices("skills")).toEqual([]);
    expect(result.current.resolveChoices("providers")).toEqual([]);
  });

  it("maps user-typed settings tokens to canonical section ids via resolveSection", async () => {
    const { result } = await renderLoadedController();

    expect(result.current.resolveSection("theme")).toBe("appearance");
    expect(result.current.resolveSection("  MODEL ")).toBe("ai-model");
    expect(
      result.current.resolveSection("not-a-real-section-token"),
    ).toBeUndefined();
    expect(result.current.resolveSection("")).toBeUndefined();
  });
});
