import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  currentScene,
  duplicate,
  redo,
  remove,
  resetToDefault,
  undo,
} from "./scene-history";
import { createDefaultScene, type HomescreenScene } from "./scene-types";

function scene(name: string): HomescreenScene {
  return { ...createDefaultScene(), id: `s-${name}`, name };
}

describe("createHistory", () => {
  it("seeds with one entry at cursor 0", () => {
    const h = createHistory();
    expect(h.entries).toHaveLength(1);
    expect(h.cursor).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

describe("commit", () => {
  it("appends and advances the cursor", () => {
    let h = createHistory(scene("a"));
    h = commit(h, scene("b"));
    expect(currentScene(h).name).toBe("b");
    expect(h.entries).toHaveLength(2);
    expect(canUndo(h)).toBe(true);
  });

  it("is a no-op when committing the identical reference", () => {
    const a = scene("a");
    let h = createHistory(a);
    h = commit(h, a);
    expect(h.entries).toHaveLength(1);
  });

  it("truncates the redo tail after an undo + commit", () => {
    let h = createHistory(scene("a"));
    h = commit(h, scene("b"));
    h = commit(h, scene("c"));
    h = undo(h); // back to b
    expect(canRedo(h)).toBe(true);
    h = commit(h, scene("d")); // branches off b
    expect(canRedo(h)).toBe(false);
    expect(h.entries.map((e) => e.name)).toEqual(["a", "b", "d"]);
  });

  it("trims the oldest entries past the limit", () => {
    let h = createHistory(scene("0"), 3);
    for (let i = 1; i <= 5; i++) h = commit(h, scene(String(i)));
    expect(h.entries).toHaveLength(3);
    expect(h.entries.map((e) => e.name)).toEqual(["3", "4", "5"]);
    expect(currentScene(h).name).toBe("5");
  });
});

describe("undo / redo", () => {
  it("moves the cursor without mutating entries", () => {
    let h = createHistory(scene("a"));
    h = commit(h, scene("b"));
    h = undo(h);
    expect(currentScene(h).name).toBe("a");
    h = redo(h);
    expect(currentScene(h).name).toBe("b");
  });

  it("undo/redo at the boundaries are no-ops", () => {
    let h = createHistory(scene("a"));
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});

describe("duplicate", () => {
  it("creates an independent copy with a new id and (copy) name", () => {
    const h0 = createHistory(scene("orig"));
    const h1 = duplicate(h0);
    const copy = currentScene(h1);
    expect(copy.name).toBe("orig (copy)");
    expect(copy.id).not.toBe(currentScene(h0).id);
    expect(h1.entries).toHaveLength(2);
  });
});

describe("resetToDefault", () => {
  it("commits the default scene and remains undoable", () => {
    let h = createHistory(scene("custom"));
    h = resetToDefault(h);
    expect(currentScene(h).id).toBe("default");
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(currentScene(h).name).toBe("custom");
  });
});

describe("remove", () => {
  it("drops the current scene and clamps the cursor", () => {
    let h = createHistory(scene("a"));
    h = commit(h, scene("b"));
    h = commit(h, scene("c")); // cursor at c (index 2)
    h = remove(h);
    expect(h.entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(currentScene(h).name).toBe("b");
  });

  it("resets to default when removing the last remaining scene", () => {
    let h = createHistory(scene("only"));
    h = remove(h);
    expect(h.entries).toHaveLength(1);
    expect(currentScene(h).id).toBe("default");
  });
});
