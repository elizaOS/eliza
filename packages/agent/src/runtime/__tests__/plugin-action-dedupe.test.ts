/**
 * Behavioral coverage for `deduplicatePluginActions`: first-wins action-name
 * uniqueness across an ordered plugin list, in-place mutation, empty and
 * missing action arrays, within-plugin duplicates, case-sensitive names, and
 * the skip-log side effect. Drives the real module; logger.debug is spied only
 * to assert the duplicate-skip message.
 */
import { type Action, logger, type Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deduplicatePluginActions } from "../plugin-action-dedupe.ts";

function namedAction(name: string): Action {
  return {
    name,
    description: `${name} fixture`,
    handler: async () => undefined,
    validate: async () => true,
  };
}

function plugin(name: string, actionNames?: readonly string[]): Plugin {
  const next: Plugin = {
    name,
    description: `${name} fixture`,
  };
  if (actionNames !== undefined) {
    next.actions = actionNames.map(namedAction);
  }
  return next;
}

function actionNamesOf(target: Plugin): string[] {
  return (target.actions ?? []).map((action) => action.name);
}

describe("deduplicatePluginActions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op on an empty plugin list", () => {
    const plugins: Plugin[] = [];
    deduplicatePluginActions(plugins);
    expect(plugins).toEqual([]);
  });

  it("keeps a single plugin's single action", () => {
    const plugins = [plugin("solo", ["ONLY"])];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["ONLY"]);
  });

  it("preserves unique action order inside a single plugin", () => {
    const plugins = [plugin("solo", ["A", "B", "C"])];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["A", "B", "C"]);
  });

  it("drops later duplicates of the same name inside one plugin", () => {
    const plugins = [plugin("solo", ["A", "B", "A", "C", "B"])];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["A", "B", "C"]);
  });

  it("keeps the first occurrence of each action name across plugins", () => {
    const plugins = [plugin("p1", ["a", "b"]), plugin("p2", ["a", "c"])];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["a", "b"]);
    expect(actionNamesOf(plugins[1])).toEqual(["c"]);
  });

  it("leaves plugins that never declared actions untouched", () => {
    const missing = plugin("p1");
    const plugins = [missing, plugin("p2", ["x"])];
    deduplicatePluginActions(plugins);
    expect(missing.actions).toBeUndefined();
    expect(plugins[0]).toBe(missing);
    expect(actionNamesOf(plugins[1])).toEqual(["x"]);
  });

  it("treats an empty actions array as present and leaves it empty", () => {
    const plugins = [plugin("empty", []), plugin("later", ["x"])];
    deduplicatePluginActions(plugins);
    expect(plugins[0].actions).toEqual([]);
    expect(actionNamesOf(plugins[1])).toEqual(["x"]);
  });

  it("keeps later unique names when they are mixed with duplicates", () => {
    const plugins = [
      plugin("p1", ["SHARED", "KEEP_FIRST"]),
      plugin("p2", ["SHARED", "UNIQUE", "KEEP_FIRST"]),
    ];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[1])).toEqual(["UNIQUE"]);
  });

  it("first-wins across three plugins with the same name", () => {
    const plugins = [
      plugin("p1", ["DUP"]),
      plugin("p2", ["DUP"]),
      plugin("p3", ["DUP", "OTHER"]),
    ];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["DUP"]);
    expect(actionNamesOf(plugins[1])).toEqual([]);
    expect(actionNamesOf(plugins[2])).toEqual(["OTHER"]);
  });

  it("treats action names as case-sensitive", () => {
    const plugins = [plugin("p1", ["Send"]), plugin("p2", ["send", "SEND"])];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(["Send"]);
    expect(actionNamesOf(plugins[1])).toEqual(["send", "SEND"]);
  });

  it("does not cap the number of unique action names", () => {
    const names = Array.from({ length: 64 }, (_, index) => `A${index}`);
    const plugins = [plugin("p", names)];
    deduplicatePluginActions(plugins);
    expect(actionNamesOf(plugins[0])).toEqual(names);
  });

  it("replaces the actions array in place but keeps surviving Action objects", () => {
    const keep = namedAction("KEEP");
    const drop = namedAction("KEEP");
    const unique = namedAction("UNIQUE");
    const first: Plugin = {
      name: "p1",
      description: "p1 fixture",
      actions: [keep],
    };
    const second: Plugin = {
      name: "p2",
      description: "p2 fixture",
      actions: [drop, unique],
    };
    const plugins = [first, second];
    const pluginsRef = plugins;
    deduplicatePluginActions(plugins);
    expect(plugins).toBe(pluginsRef);
    expect(plugins[0]).toBe(first);
    expect(plugins[1]).toBe(second);
    expect(plugins[0].actions).toEqual([keep]);
    expect(plugins[0].actions?.[0]).toBe(keep);
    expect(plugins[1].actions).toEqual([unique]);
    expect(plugins[1].actions?.[0]).toBe(unique);
  });

  it("logs a debug skip for each duplicate action with plugin and action names", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const plugins = [
      plugin("first", ["SHARED"]),
      plugin("second", ["SHARED", "ALSO", "SHARED"]),
    ];
    deduplicatePluginActions(plugins);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenNthCalledWith(
      1,
      '[eliza] Skipping duplicate action "SHARED" from plugin "second"',
    );
    expect(debug).toHaveBeenNthCalledWith(
      2,
      '[eliza] Skipping duplicate action "SHARED" from plugin "second"',
    );
  });

  it("does not log when every action name is unique", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    deduplicatePluginActions([plugin("p1", ["A"]), plugin("p2", ["B"])]);
    expect(debug).not.toHaveBeenCalled();
  });
});
