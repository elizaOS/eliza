/** Pins the release view manifests and their server capability surfaces. */

import { describe, expect, it } from "vitest";
import { notesPlugin } from "./plugin.js";

describe("notesPlugin", () => {
  it("registers only the managed Cloud Notes view", () => {
    expect(notesPlugin.views?.map((view) => view.id)).toEqual(["notes"]);
    for (const view of notesPlugin.views ?? []) {
      expect(view.developerOnly).not.toBe(true);
      expect(view.viewKind).toBe("release");
      expect(view.serverInteract).toBeTypeOf("function");
      expect(view.surface).toEqual({ header: "fullscreen" });
      expect(view.surface?.capabilities).toBeUndefined();
    }
  });

  it("exposes full update as well as create and delete capabilities", () => {
    const notes = notesPlugin.views?.find((view) => view.id === "notes");
    expect(notes?.capabilities?.map((capability) => capability.id)).toEqual(
      expect.arrayContaining([
        "create-note",
        "update-note",
        "delete-note",
        "clear-notes",
      ]),
    );
  });
});
