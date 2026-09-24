/** Exercises owner-only Notes context registration and role filtering. */

import { ContextRegistry, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { formatAvailableContextsForPrompt } from "../../plugin-assistant/src/services/message.ts";
import { notesAction } from "./action.js";
import { notesPlugin } from "./plugin.js";

describe("notesPlugin", () => {
  it("requires a snapshot revision for PATCH while retaining atomic UPDATE substitutions", () => {
    const patch = notesPlugin.actions?.find(
      (action) => action.name === "NOTES_PATCH",
    );
    const update = notesPlugin.actions?.find(
      (action) => action.name === "NOTES_UPDATE",
    );
    expect(
      patch?.parameters?.find((p) => p.name === "expectedRevision")?.required,
    ).toBe(true);
    expect(
      update?.parameters?.find((p) => p.name === "expectedRevision")?.required,
    ).toBe(false);
    expect(
      update?.parameters?.find((p) => p.name === "textEdit"),
    ).toBeDefined();
  });
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
    const ownerCatalog = formatAvailableContextsForPrompt(
      contexts.listAvailable(["OWNER"]),
    );
    const nonOwnerCatalog = formatAvailableContextsForPrompt(
      contexts.listAvailable(["USER"]),
    );
    for (const action of notesPlugin.actions ?? []) {
      if (action === notesAction) continue;
      expect(ownerCatalog).toContain(action.name);
      expect(nonOwnerCatalog).not.toContain(action.name);
    }
  });
});
