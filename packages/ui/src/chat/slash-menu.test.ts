import { describe, expect, it, vi } from "vitest";
import type { SlashCommandCatalogItem } from "./slash-menu";
import {
  activeArgIndex,
  completeArg,
  completeCommand,
  filterArgChoices,
  filterCommands,
  matchCommand,
  parseSlashDraft,
  resolveSlashExecution,
  runSlashExecution,
  type SlashExecutionDeps,
} from "./slash-menu";

function cmd(
  partial: Partial<SlashCommandCatalogItem>,
): SlashCommandCatalogItem {
  return {
    key: partial.key ?? "x",
    nativeName: partial.nativeName ?? partial.key ?? "x",
    description: partial.description ?? "",
    textAliases: partial.textAliases ?? [`/${partial.key ?? "x"}`],
    scope: partial.scope ?? "both",
    acceptsArgs: partial.acceptsArgs ?? (partial.args?.length ?? 0) > 0,
    args: partial.args ?? [],
    requiresAuth: partial.requiresAuth ?? false,
    requiresElevated: partial.requiresElevated ?? false,
    target: partial.target ?? { kind: "agent" },
    ...partial,
  };
}

const CATALOG: SlashCommandCatalogItem[] = [
  cmd({
    key: "settings",
    textAliases: ["/settings", "/preferences"],
    description: "Open settings",
    acceptsArgs: true,
    args: [
      {
        name: "section",
        description: "section",
        choices: ["model", "voice", "connectors"],
        dynamicChoices: "settings-sections",
      },
    ],
    target: { kind: "navigate", tab: "settings", path: "/settings" },
  }),
  cmd({
    key: "orchestrator",
    textAliases: ["/orchestrator", "/workbench"],
    description: "Open orchestrator",
    target: { kind: "navigate", viewId: "orchestrator", path: "/orchestrator" },
  }),
  cmd({
    key: "plugins",
    textAliases: ["/plugins"],
    description: "Open plugins",
    target: { kind: "navigate", tab: "plugins", path: "/apps/plugins" },
  }),
  cmd({
    key: "clear",
    textAliases: ["/clear", "/cls"],
    description: "Clear chat",
    target: { kind: "client", clientAction: "clear-chat" },
  }),
  cmd({
    key: "model",
    textAliases: ["/model", "/m"],
    description: "Set model",
    acceptsArgs: true,
    args: [{ name: "model", description: "model", dynamicChoices: "models" }],
    target: { kind: "agent" },
  }),
  cmd({
    key: "help",
    textAliases: ["/help", "/h", "/?"],
    description: "Show help",
    target: { kind: "agent" },
  }),
];

describe("parseSlashDraft", () => {
  it("is inert for non-slash and multiline drafts", () => {
    expect(parseSlashDraft("").isSlash).toBe(false);
    expect(parseSlashDraft("hello").isSlash).toBe(false);
    expect(parseSlashDraft("/settings\nmore").isSlash).toBe(false);
  });

  it("parses a bare command token", () => {
    const p = parseSlashDraft("/set");
    expect(p.isSlash).toBe(true);
    expect(p.commandToken).toBe("set");
    expect(p.hasSpace).toBe(false);
    expect(p.argQuery).toBe("set");
  });

  it("lowercases the command token and tolerates leading space", () => {
    const p = parseSlashDraft("  /Settings");
    expect(p.commandToken).toBe("settings");
  });

  it("parses args after a space", () => {
    const p = parseSlashDraft("/settings mod");
    expect(p.hasSpace).toBe(true);
    expect(p.commandToken).toBe("settings");
    expect(p.argTokens).toEqual(["mod"]);
    expect(p.argQuery).toBe("mod");
  });

  it("treats a trailing space as a fresh empty arg", () => {
    const p = parseSlashDraft("/settings ");
    expect(p.hasSpace).toBe(true);
    expect(p.argTokens).toEqual([]);
    expect(p.argQuery).toBe("");
  });
});

describe("matchCommand", () => {
  it("matches by any alias, exact only", () => {
    expect(matchCommand(CATALOG, "settings")?.key).toBe("settings");
    expect(matchCommand(CATALOG, "preferences")?.key).toBe("settings");
    expect(matchCommand(CATALOG, "m")?.key).toBe("model");
    expect(matchCommand(CATALOG, "set")).toBeUndefined();
  });
});

describe("filterCommands", () => {
  it("returns all commands for an empty query", () => {
    expect(filterCommands(CATALOG, "")).toHaveLength(CATALOG.length);
  });

  it("ranks alias prefix above description substring", () => {
    const out = filterCommands(CATALOG, "set");
    expect(out[0].key).toBe("settings");
  });

  it("matches description text too", () => {
    const out = filterCommands(CATALOG, "orchestr");
    expect(out.some((c) => c.key === "orchestrator")).toBe(true);
  });

  it("excludes non-matches", () => {
    const out = filterCommands(CATALOG, "zzzz");
    expect(out).toHaveLength(0);
  });
});

describe("activeArgIndex + filterArgChoices", () => {
  const settings = CATALOG[0];
  it("is -1 before a space", () => {
    expect(activeArgIndex(settings, parseSlashDraft("/settings"))).toBe(-1);
  });
  it("is 0 while typing the first arg", () => {
    expect(activeArgIndex(settings, parseSlashDraft("/settings mo"))).toBe(0);
    expect(activeArgIndex(settings, parseSlashDraft("/settings "))).toBe(0);
  });
  it("filters choices by prefix then substring", () => {
    expect(filterArgChoices(["model", "voice", "connectors"], "")).toHaveLength(
      3,
    );
    expect(filterArgChoices(["model", "voice", "connectors"], "mo")).toEqual([
      "model",
    ]);
  });
});

describe("completion", () => {
  it("completeCommand appends a space for arg-taking commands", () => {
    expect(completeCommand(CATALOG[0])).toBe("/settings ");
    expect(completeCommand(CATALOG[5])).toBe("/help");
  });
  it("completeArg replaces the active token preserving the typed alias", () => {
    expect(completeArg(parseSlashDraft("/settings mo"), "model")).toBe(
      "/settings model",
    );
    expect(completeArg(parseSlashDraft("/preferences "), "voice")).toBe(
      "/preferences voice",
    );
  });
});

describe("resolveSlashExecution", () => {
  const resolveSection = (t: string) =>
    ({ model: "ai-model", voice: "voice", connectors: "connectors" })[t];

  it("resolves a settings section from the argument", () => {
    expect(
      resolveSlashExecution(CATALOG[0], "/settings model", resolveSection),
    ).toEqual({ kind: "navigate-settings", section: "ai-model" });
  });

  it("opens the settings hub with no argument", () => {
    expect(resolveSlashExecution(CATALOG[0], "/settings")).toEqual({
      kind: "navigate-settings",
    });
  });

  it("navigates to a view by id", () => {
    expect(resolveSlashExecution(CATALOG[1], "/orchestrator")).toEqual({
      kind: "navigate-view",
      viewId: "orchestrator",
      viewPath: "/orchestrator",
    });
  });

  it("navigates to a tab", () => {
    expect(resolveSlashExecution(CATALOG[2], "/plugins")).toEqual({
      kind: "navigate-tab",
      tab: "plugins",
    });
  });

  it("runs a client action", () => {
    expect(resolveSlashExecution(CATALOG[3], "/clear")).toEqual({
      kind: "client",
      clientAction: "clear-chat",
    });
  });

  it("sends agent commands as literal text", () => {
    expect(resolveSlashExecution(CATALOG[4], "/model gpt-5")).toEqual({
      kind: "send",
      text: "/model gpt-5",
    });
  });
});

describe("runSlashExecution", () => {
  function deps(): SlashExecutionDeps {
    return {
      navigateTab: vi.fn(),
      navigateSettings: vi.fn(),
      navigateView: vi.fn(),
      clearChat: vi.fn(),
      newConversation: vi.fn(),
      toggleFullscreen: vi.fn(),
      openCommandPalette: vi.fn(),
      showCommands: vi.fn(),
      send: vi.fn(),
    };
  }

  it("dispatches each execution kind to the right dep", () => {
    const d = deps();
    runSlashExecution({ kind: "navigate-tab", tab: "plugins" }, d);
    expect(d.navigateTab).toHaveBeenCalledWith("plugins");

    runSlashExecution({ kind: "navigate-settings", section: "ai-model" }, d);
    expect(d.navigateSettings).toHaveBeenCalledWith("ai-model");

    runSlashExecution({ kind: "navigate-view", viewId: "orchestrator" }, d);
    expect(d.navigateView).toHaveBeenCalledWith({
      viewId: "orchestrator",
      viewPath: undefined,
    });

    runSlashExecution({ kind: "client", clientAction: "clear-chat" }, d);
    expect(d.clearChat).toHaveBeenCalled();

    runSlashExecution({ kind: "client", clientAction: "toggle-fullscreen" }, d);
    expect(d.toggleFullscreen).toHaveBeenCalled();

    runSlashExecution({ kind: "send", text: "/model x" }, d);
    expect(d.send).toHaveBeenCalledWith("/model x");
  });
});
