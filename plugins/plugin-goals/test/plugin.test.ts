/**
 * Plugin-manifest contract test (node env, no DOM).
 *
 * Guards the `goals` view registration that the shared ui-smoke
 * (packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts)
 * and the route-coverage harness rely on: a single gui view whose
 * `componentExport` ("GoalsView") and `path` ("/goals") must stay in lockstep
 * with the actual exported component, or the shell will mount the wrong / no
 * module. Also pins the four owner actions and the check-in service so the
 * plugin surface can't silently drift.
 *
 * External-API contract test: N/A — the plugin views/actions perform no fetch
 * against a third-party API, so there is no real API shape to validate here.
 */

import { describe, expect, it } from "vitest";

import { GoalsCheckinService, GoalsView, goalsPlugin } from "../src/index.ts";

describe("goalsPlugin manifest", () => {
  it("identifies as @elizaos/plugin-goals and depends on plugin-sql", () => {
    expect(goalsPlugin.name).toBe("@elizaos/plugin-goals");
    expect(goalsPlugin.dependencies).toEqual(["@elizaos/plugin-sql"]);
  });

  it("registers exactly one view: the gui `goals` surface", () => {
    expect(goalsPlugin.views).toBeDefined();
    expect(goalsPlugin.views).toHaveLength(1);

    const view = goalsPlugin.views?.[0];
    expect(view).toBeDefined();
    if (!view) throw new Error("goals view missing");

    expect(view.id).toBe("goals");
    expect(view.label).toBe("Goals");
    expect(view.path).toBe("/goals");
    expect(view.icon).toBe("Target");
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    expect(view.componentExport).toBe("GoalsView");
    expect(view.desktopTabEnabled).toBe(true);
    expect(view.visibleInManager).toBe(true);
    // viewType defaults to "gui" when omitted (see ViewDeclaration docs).
    expect(view.viewType === undefined || view.viewType === "gui").toBe(true);
    expect(view.tags).toContain("goals");
  });

  it("exports the GoalsView component the view registration names", () => {
    // The `componentExport` string must resolve to a real exported component on
    // the package barrel, since the shell loads `module[componentExport]`.
    expect(goalsPlugin.views?.[0]?.componentExport).toBe("GoalsView");
    expect(typeof GoalsView).toBe("function");
  });

  it("registers the four owner actions and the check-in service", () => {
    const actionNames = (goalsPlugin.actions ?? []).map((a) => a.name);
    expect(actionNames).toEqual([
      "OWNER_GOALS",
      "OWNER_ROUTINES",
      "OWNER_REMINDERS",
      "OWNER_ALARMS",
    ]);

    expect(goalsPlugin.services).toContain(GoalsCheckinService);
  });

  it("registers a drizzle schema object for migration", () => {
    expect(goalsPlugin.schema).toBeDefined();
    expect(typeof goalsPlugin.schema).toBe("object");
  });
});
