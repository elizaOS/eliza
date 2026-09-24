/**
 * Covers plugin-object selection out of an elizaOS plugin barrel module.
 *
 * The trusted runtime server loads production plugins under the `eliza-source`
 * condition, where every plugin package resolves to a `src/index.ts` barrel with
 * no default export; selecting the module namespace's first key picked an
 * arbitrary helper and made the server unstartable.
 */

import { describe, expect, it } from "vitest";
import { selectPluginExport, toPlugin } from "../server-utils.js";

const realPlugin = {
  name: "personal-assistant",
  description: "LifeOps",
  actions: [],
};

describe("selectPluginExport", () => {
  it("finds the plugin object in a barrel with no default export", () => {
    const barrel = {
      getAppBlockerStatus: () => undefined,
      LIFEOPS_TASK_NAME: "lifeops",
      personalAssistantPlugin: realPlugin,
    };
    expect(
      selectPluginExport(barrel, "@elizaos/plugin-personal-assistant"),
    ).toBe(realPlugin);
  });

  it("prefers a plugin-shaped default export", () => {
    const barrel = { default: realPlugin, otherPlugin: { name: "other" } };
    expect(selectPluginExport(barrel, "@elizaos/plugin-calendar")).toBe(
      realPlugin,
    );
  });

  it("disambiguates multiple plugin objects by package short name", () => {
    const calendar = { name: "calendar", services: [] };
    const barrel = {
      calendarPlugin: calendar,
      routesPlugin: { name: "calendar-routes", routes: [] },
    };
    expect(selectPluginExport(barrel, "@elizaos/plugin-calendar")).toBe(
      calendar,
    );
  });

  it("matches a plugin whose name is the full package specifier", () => {
    const barrel = {
      personalAssistantPlugin: {
        name: "@elizaos/plugin-personal-assistant",
        actions: [],
      },
      personalAssistantRoutesPlugin: { name: "lifeops-routes", routes: [] },
    };
    expect(
      selectPluginExport(barrel, "@elizaos/plugin-personal-assistant"),
    ).toBe(barrel.personalAssistantPlugin);
  });

  it("rejects ambiguous barrels instead of guessing", () => {
    const barrel = {
      a: { name: "alpha", actions: [] },
      b: { name: "beta", actions: [] },
    };
    expect(() => selectPluginExport(barrel, "@elizaos/plugin-gamma")).toThrow(
      /multiple plugin objects/,
    );
  });

  it("leaves the missing-plugin failure to toPlugin", () => {
    const barrel = { helper: () => undefined };
    expect(() =>
      toPlugin(
        selectPluginExport(barrel, "@elizaos/plugin-empty"),
        "@elizaos/plugin-empty",
      ),
    ).toThrow(/was not an object/);
  });
});
