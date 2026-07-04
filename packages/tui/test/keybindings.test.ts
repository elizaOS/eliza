/**
 * Keybinding tests verify the default editor action map and runtime remapping
 * behavior.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_KEYBINDINGS,
  EditorKeybindingsManager,
} from "../src/keybindings.js";

describe("editor keybindings", () => {
  it("does not expose dead session/tool selection actions in defaults", () => {
    const removedActions = [
      "selectPageUp",
      "selectPageDown",
      "expandTools",
      "toggleSessionPath",
      "toggleSessionSort",
      "renameSession",
      "deleteSession",
      "deleteSessionNoninvasive",
    ];

    expect(Object.keys(DEFAULT_EDITOR_KEYBINDINGS)).not.toEqual(
      expect.arrayContaining(removedActions),
    );
  });

  it("keeps live selection bindings available", () => {
    const keybindings = new EditorKeybindingsManager();

    expect(keybindings.getKeys("selectUp")).toEqual(["up"]);
    expect(keybindings.getKeys("selectDown")).toEqual(["down"]);
    expect(keybindings.getKeys("selectConfirm")).toEqual(["enter"]);
    expect(keybindings.getKeys("selectCancel")).toEqual(["escape", "ctrl+c"]);
  });
});
