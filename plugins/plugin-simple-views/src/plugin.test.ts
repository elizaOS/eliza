/** Pins the release view manifests and their server capability surfaces. */

import { describe, expect, it } from "vitest";
import { simpleViewsPlugin } from "./plugin.js";

describe("simpleViewsPlugin", () => {
  it("registers only the two managed Cloud views", () => {
    expect(simpleViewsPlugin.views?.map((view) => view.id)).toEqual([
      "notes",
      "simple-calendar",
    ]);
    for (const view of simpleViewsPlugin.views ?? []) {
      expect(view.developerOnly).not.toBe(true);
      expect(view.viewKind).toBe("release");
      expect(view.serverInteract).toBeTypeOf("function");
      expect(view.surface).toEqual({ header: "fullscreen" });
      expect(view.surface?.capabilities).toBeUndefined();
    }
  });

  it("exposes full update as well as create and delete capabilities", () => {
    const notes = simpleViewsPlugin.views?.find((view) => view.id === "notes");
    const calendar = simpleViewsPlugin.views?.find(
      (view) => view.id === "simple-calendar",
    );
    expect(notes?.capabilities?.map((capability) => capability.id)).toEqual(
      expect.arrayContaining([
        "create-note",
        "update-note",
        "delete-note",
        "clear-notes",
      ]),
    );
    expect(calendar?.capabilities?.map((capability) => capability.id)).toEqual(
      expect.arrayContaining([
        "create-calendar-event",
        "update-calendar-event",
        "delete-calendar-event",
        "select-calendar-date",
      ]),
    );
  });
});
