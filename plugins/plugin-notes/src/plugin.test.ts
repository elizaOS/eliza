/** Pins the release view manifests and their server capability surfaces. */

import { ContextRegistry, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { notesPlugin } from "./plugin.js";

describe("notesPlugin", () => {
  it("registers an owner-only Stage 1 notes context during plugin init", async () => {
    const contexts = new ContextRegistry([]);
    await notesPlugin.init?.({}, { contexts } as IAgentRuntime);

    expect(contexts.get("notes")).toMatchObject({
      id: "notes",
      sensitivity: "personal",
      roleGate: { minRole: "OWNER" },
    });
    expect(contexts.listAvailable(["USER"]).map(({ id }) => id)).not.toContain(
      "notes",
    );
    expect(contexts.listAvailable(["OWNER"]).map(({ id }) => id)).toContain(
      "notes",
    );
  });

  it("registers only the managed Cloud Notes view", () => {
    expect(notesPlugin.views?.map((view) => view.id)).toEqual(["notes"]);
    expect(notesPlugin.views?.[0]?.roleGate).toEqual({ minRole: "OWNER" });
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
