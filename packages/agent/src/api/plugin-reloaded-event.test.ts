/**
 * Unit coverage for `buildPluginReloadedViewEvent`, pinning the exact
 * `view:event` payload shape the dashboard's plugin-refresh path consumes.
 * Deterministic pure-function assertion.
 */
import { describe, expect, it } from "vitest";
import { buildPluginReloadedViewEvent } from "./plugin-reloaded-event";

describe("buildPluginReloadedViewEvent", () => {
  it("builds the view:event payload consumed by the dashboard refresh path", () => {
    expect(
      buildPluginReloadedViewEvent({
        pluginName: "@elizaos/plugin-habit-tracker",
        directory: "/repo/plugins/plugin-habit-tracker",
        source: "plugins.load-from-directory",
      }),
    ).toEqual({
      type: "view:event",
      viewEventType: "plugin_reloaded",
      payload: {
        pluginName: "@elizaos/plugin-habit-tracker",
        directory: "/repo/plugins/plugin-habit-tracker",
        source: "plugins.load-from-directory",
      },
    });
  });
});
