/**
 * Registers the real Simple Views workbench manifest and proves its semantic
 * operations survive the registry-to-planner context boundary, including a
 * split layout where both panes must remain independently addressable.
 */

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleViewsPlugin } from "../../../../plugins/plugin-simple-views/src/plugin.ts";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import {
  renderActiveViewContextBlock,
  viewDeclaredCapabilities,
} from "./view-action-affinity.ts";

const SIMPLE_VIEWS_PACKAGE_DIR = fileURLToPath(
  new URL("../../../../plugins/plugin-simple-views/", import.meta.url),
);

describe("Simple Views planner capability context", () => {
  beforeAll(async () => {
    unregisterPluginViews(simpleViewsPlugin.name);
    await registerPluginViews(simpleViewsPlugin, SIMPLE_VIEWS_PACKAGE_DIR);
  });

  afterAll(() => {
    unregisterPluginViews(simpleViewsPlugin.name);
  });

  it("renders the registered Notes schema with its required create parameter", () => {
    const capabilities = viewDeclaredCapabilities("notes");
    expect(capabilities.map(({ id }) => id)).toEqual([
      "get-notes",
      "get-note",
      "create-note",
      "update-note",
      "delete-note",
      "clear-notes",
    ]);
    expect(
      capabilities.find(({ id }) => id === "create-note")?.params,
    ).toMatchObject({
      title: { type: "string", required: true },
      body: { type: "string" },
      color: { type: "string" },
    });

    const context = renderActiveViewContextBlock({
      viewId: "notes",
      viewLabel: "Notes",
      viewType: "gui",
      viewPath: "/notes",
    });
    expect(context).toContain(
      'through VIEWS with action="interact" and view="notes"',
    );
    expect(context).toContain(
      "create-note { title: string, required; body: string; color: string }",
    );
    expect(context).toContain("get-notes");
  });

  it("retains both real capability catalogs in a Notes and Calendar split", () => {
    const context = renderActiveViewContextBlock({
      viewId: "notes",
      viewLabel: "Notes",
      viewType: "gui",
      viewPath: "/notes",
      viewIds: ["notes", "simple-calendar"],
      layout: "horizontal",
      placement: "left",
    });

    expect(context).toContain(
      "Visible panes in the horizontal layout: Notes (notes), Simple Calendar (simple-calendar)",
    );
    expect(context).toContain('action="interact" and view="notes"');
    expect(context).toContain('action="interact" and view="simple-calendar"');
    expect(context).toContain("create-note");
    expect(context).toContain("get-notes");
    expect(context).toContain("create-calendar-event");
    expect(context).toContain("get-calendar-state");
  });
});
