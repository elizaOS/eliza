import assert from "node:assert";
import { describe, it } from "vitest";
import {
  DEFAULT_EDITOR_KEYBINDINGS,
  type EditorAction,
  EditorKeybindingsManager,
} from "../src/keybindings.js";

describe("EditorKeybindingsManager", () => {
  it("keeps default bindings limited to live editor actions", () => {
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
    const defaults = Object.keys(DEFAULT_EDITOR_KEYBINDINGS);
    const manager = new EditorKeybindingsManager();

    for (const action of removedActions) {
      assert.ok(!defaults.includes(action));
      assert.deepStrictEqual(manager.getKeys(action as EditorAction), []);
    }
    assert.deepStrictEqual(manager.getKeys("selectUp"), ["up"]);
    assert.deepStrictEqual(manager.getKeys("selectCancel"), [
      "escape",
      "ctrl+c",
    ]);
  });
});
