/**
 * Behavioral coverage for `getPluginWidgets`: identity matching after scope
 * and prefix stripping, empty/missing runtime lists, first-match wins, and
 * shallow-copy of the matched plugin's widgets array.
 */
import type { Plugin, PluginWidgetDeclaration } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getPluginWidgets } from "./plugin-widgets.ts";

function widget(
  id: string,
  pluginId: string,
  slot: PluginWidgetDeclaration["slot"] = "home",
  label = "Overview",
): PluginWidgetDeclaration {
  return { id, pluginId, slot, label };
}

function plugin(name: string, widgets?: PluginWidgetDeclaration[]): Plugin {
  const declared: Plugin = { name, description: "fixture plugin" };
  if (widgets !== undefined) {
    declared.widgets = widgets;
  }
  return declared;
}

describe("getPluginWidgets", () => {
  it("returns an empty list when runtimePlugins is omitted", () => {
    expect(getPluginWidgets("discord")).toEqual([]);
  });

  it("returns an empty list when runtimePlugins is undefined", () => {
    expect(getPluginWidgets("discord", undefined)).toEqual([]);
  });

  it("returns an empty list for an empty runtime plugin queue", () => {
    expect(getPluginWidgets("discord", [])).toEqual([]);
  });

  it("returns an empty list when no plugin identity matches", () => {
    const widgets = [widget("overview", "telegram")];
    expect(getPluginWidgets("discord", [plugin("telegram", widgets)])).toEqual(
      [],
    );
  });

  it("returns an empty list when the matched plugin omits widgets", () => {
    expect(getPluginWidgets("discord", [plugin("discord")])).toEqual([]);
  });

  it("returns an empty list when the matched plugin declares an empty widgets array", () => {
    expect(getPluginWidgets("discord", [plugin("discord", [])])).toEqual([]);
  });

  it("returns the single declared widget for an exact name match", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("discord", [plugin("discord", [overview])]),
    ).toEqual([overview]);
  });

  it("preserves widget order for a plugin that declares several widgets", () => {
    const first = widget("overview", "discord", "home", "Overview");
    const second = widget("inbox", "discord", "chat-sidebar", "Inbox");
    const third = widget("profile", "discord", "character", "Profile");
    expect(
      getPluginWidgets("discord", [plugin("discord", [first, second, third])]),
    ).toEqual([first, second, third]);
  });

  it("matches after trimming whitespace on the plugin id and plugin name", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("  discord  ", [plugin("  discord  ", [overview])]),
    ).toEqual([overview]);
  });

  it("matches a plugin- prefixed id against an unprefixed Plugin.name", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("plugin-discord", [plugin("discord", [overview])]),
    ).toEqual([overview]);
  });

  it("matches an unprefixed id against a plugin- prefixed Plugin.name", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("discord", [plugin("plugin-discord", [overview])]),
    ).toEqual([overview]);
  });

  it("matches an app- prefixed id against an unprefixed Plugin.name", () => {
    const overview = widget("overview", "wallet");
    expect(
      getPluginWidgets("app-wallet", [plugin("wallet", [overview])]),
    ).toEqual([overview]);
  });

  it("matches an unprefixed id against an app- prefixed Plugin.name", () => {
    const overview = widget("overview", "wallet");
    expect(
      getPluginWidgets("wallet", [plugin("app-wallet", [overview])]),
    ).toEqual([overview]);
  });

  it("strips an npm scope before comparing identities", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("@elizaos/discord", [plugin("discord", [overview])]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("discord", [plugin("@elizaos/discord", [overview])]),
    ).toEqual([overview]);
  });

  it("strips scope then plugin- so @scope/plugin-name matches a bare id", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("discord", [
        plugin("@elizaos/plugin-discord", [overview]),
      ]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("@elizaos/plugin-discord", [
        plugin("plugin-discord", [overview]),
      ]),
    ).toEqual([overview]);
  });

  it("strips plugin- then app- so plugin-app-wallet matches wallet", () => {
    const overview = widget("overview", "wallet");
    expect(
      getPluginWidgets("plugin-app-wallet", [plugin("wallet", [overview])]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("wallet", [plugin("plugin-app-wallet", [overview])]),
    ).toEqual([overview]);
  });

  it("does not strip plugin- after an app- prefix (app- is applied second, once)", () => {
    const overview = widget("overview", "plugin-wallet");
    // "app-plugin-wallet" -> "plugin-wallet"; "plugin-wallet" -> "wallet"
    expect(
      getPluginWidgets("app-plugin-wallet", [
        plugin("plugin-wallet", [overview]),
      ]),
    ).toEqual([]);
    expect(
      getPluginWidgets("app-plugin-wallet", [
        plugin("app-plugin-wallet", [overview]),
      ]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("wallet", [plugin("app-plugin-wallet", [overview])]),
    ).toEqual([]);
  });

  it("strips the plugin- prefix only once", () => {
    const overview = widget("overview", "plugin-discord");
    // "plugin-plugin-discord" -> "plugin-discord"; "plugin-discord" -> "discord"
    expect(
      getPluginWidgets("plugin-plugin-discord", [
        plugin("plugin-discord", [overview]),
      ]),
    ).toEqual([]);
    expect(
      getPluginWidgets("plugin-plugin-discord", [
        plugin("plugin-plugin-discord", [overview]),
      ]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("discord", [
        plugin("plugin-plugin-discord", [overview]),
      ]),
    ).toEqual([]);
  });

  it("leaves an @-prefixed name without a slash unscoped", () => {
    const overview = widget("overview", "noscoped");
    expect(
      getPluginWidgets("@noscoped", [plugin("@noscoped", [overview])]),
    ).toEqual([overview]);
    expect(
      getPluginWidgets("noscoped", [plugin("@noscoped", [overview])]),
    ).toEqual([]);
  });

  it("treats identity comparison as case-sensitive", () => {
    const overview = widget("overview", "discord");
    expect(
      getPluginWidgets("Discord", [plugin("discord", [overview])]),
    ).toEqual([]);
    expect(
      getPluginWidgets("plugin-Discord", [
        plugin("plugin-discord", [overview]),
      ]),
    ).toEqual([]);
  });

  it("returns the first identity match when several plugins normalize to the same id", () => {
    const first = widget("first", "discord", "home", "First");
    const second = widget("second", "discord", "home", "Second");
    expect(
      getPluginWidgets("discord", [
        plugin("other", [widget("noise", "other")]),
        plugin("plugin-discord", [first]),
        plugin("discord", [second]),
      ]),
    ).toEqual([first]);
  });

  it("does not fall through to a later same-identity plugin when the first match has no widgets", () => {
    const later = widget("later", "discord");
    expect(
      getPluginWidgets("discord", [
        plugin("plugin-discord"),
        plugin("discord", [later]),
      ]),
    ).toEqual([]);
  });

  it("ignores a later plugin's widgets when its identity does not match", () => {
    const telegram = widget("overview", "telegram");
    expect(
      getPluginWidgets("discord", [
        plugin("discord"),
        plugin("telegram", [telegram]),
      ]),
    ).toEqual([]);
  });

  it("returns a shallow copy so mutating the result does not change the plugin", () => {
    const overview = widget("overview", "discord");
    const inbox = widget("inbox", "discord", "chat-sidebar", "Inbox");
    const widgets = [overview, inbox];
    const runtime = [plugin("discord", widgets)];

    const result = getPluginWidgets("discord", runtime);
    expect(result).toEqual(widgets);
    expect(result).not.toBe(widgets);
    expect(result[0]).toBe(overview);

    result.pop();
    result[0] = widget("mutated", "discord");

    expect(runtime[0]?.widgets).toEqual([overview, inbox]);
    expect(getPluginWidgets("discord", runtime)).toEqual([overview, inbox]);
  });

  it("matches an empty plugin id only against a name that also normalizes to empty", () => {
    const emptyName = widget("empty", "");
    const discord = widget("overview", "discord");
    expect(getPluginWidgets("", [plugin("discord", [discord])])).toEqual([]);
    expect(getPluginWidgets("", [plugin("", [emptyName])])).toEqual([
      emptyName,
    ]);
    expect(getPluginWidgets("plugin-", [plugin("app-", [emptyName])])).toEqual([
      emptyName,
    ]);
  });
});
