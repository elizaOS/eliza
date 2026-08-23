import { describe, expect, it } from "vitest";
import { getPluginWidgets } from "../plugin-widgets.ts";

const mkPlugin = (name: string, widgets?: unknown[]) =>
  ({ name, widgets }) as never;

describe("getPluginWidgets", () => {
  it("returns empty when no runtime plugins are supplied", () => {
    expect(getPluginWidgets("plugin-a", undefined)).toEqual([]);
    expect(getPluginWidgets("plugin-a", [])).toEqual([]);
  });

  it("matches plugins by normalized identity", () => {
    const widgets = [{ id: "w1" }, { id: "w2" }];
    const plugins = [mkPlugin("@elizaos/plugin-chat", widgets)];
    const result = getPluginWidgets("plugin-chat", plugins) as { id: string }[];
    expect(result.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("returns a copy of the widgets array", () => {
    const widgets = [{ id: "w1" }];
    const plugins = [mkPlugin("@elizaos/plugin-chat", widgets)];
    const result = getPluginWidgets("plugin-chat", plugins);
    expect(result).toEqual(widgets);
    expect(result).not.toBe(widgets);
  });

  it("returns empty when the matched plugin declares no widgets", () => {
    const plugins = [mkPlugin("@elizaos/plugin-bare")];
    expect(getPluginWidgets("plugin-bare", plugins)).toEqual([]);
  });
});
