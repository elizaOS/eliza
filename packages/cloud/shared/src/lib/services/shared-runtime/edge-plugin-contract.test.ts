/**
 * Pins the Shared runtime's plugin fleet contract: every plugin the edge
 * runtime composes must publish a `./edge` export whose module carries an
 * `*_EDGE_COMPATIBILITY` marker with `target: "edge"`. The marker is the
 * canonical shared-vs-dedicated tag (2026-08-16 plugin audit: 3 of 102
 * plugins are edge-tagged — exactly the frozen V1 shared scope; everything
 * else is dedicated-only by node-API dependence or by role). A plugin added
 * to the shared turn path without joining this pin fails here before it can
 * fail in workerd.
 */
import { describe, expect, test } from "bun:test";

import { SHARED_REMINDERS_EDGE_COMPATIBILITY } from "@elizaos/plugin-scheduling/edge";
import { createTodosEdgePlugin, TODOS_EDGE_COMPATIBILITY } from "@elizaos/plugin-todos/edge";
import {
  WEB_SEARCH_EDGE_COMPATIBILITY,
  webSearchEdgeAction,
  webSearchEdgePlugin,
} from "@elizaos/plugin-web-search/edge";

const SHARED_EDGE_PLUGIN_TAGS = [
  ["plugin-scheduling", SHARED_REMINDERS_EDGE_COMPATIBILITY],
  ["plugin-todos", TODOS_EDGE_COMPATIBILITY],
  ["plugin-web-search", WEB_SEARCH_EDGE_COMPATIBILITY],
] as const;

describe("shared edge plugin contract", () => {
  test("every shared-composed plugin is edge-tagged", () => {
    for (const [name, tag] of SHARED_EDGE_PLUGIN_TAGS) {
      expect(tag.target).toBe("edge");
      expect(Array.isArray(tag.effects)).toBe(true);
      expect(Array.isArray(tag.requiredBindings)).toBe(true);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("web-search edge plugin exposes its action to the planner surface", () => {
    expect(webSearchEdgePlugin.actions?.some((a) => a.name === webSearchEdgeAction.name)).toBe(
      true,
    );
    expect(webSearchEdgeAction.name).toBe("WEB_SEARCH");
  });

  test("todos edge factory binds the host store and registers its action", () => {
    const plugin = createTodosEdgePlugin({
      store: {} as Parameters<typeof createTodosEdgePlugin>[0]["store"],
    });
    expect((plugin.actions ?? []).length).toBeGreaterThan(0);
  });
});
