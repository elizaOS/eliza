import { describe, expect, it } from "vitest";
import { applyHomescreenInstruction } from "./scene-apply";
import { createHistory, currentScene } from "./scene-history";
import { createDefaultScene } from "./scene-types";

const VALID = JSON.stringify({
  name: "Black",
  background: { kind: "preset", preset: "fresnel-crystal-ball" },
  theme: { accent: [1, 0.345, 0], background: 0 },
});

describe("applyHomescreenInstruction", () => {
  it("commits a valid edit document", () => {
    const h0 = createHistory();
    const { history, error } = applyHomescreenInstruction(h0, {
      op: "edit",
      sceneJson: VALID,
    });
    expect(error).toBeNull();
    expect(history.entries.length).toBe(2);
    expect(currentScene(history).name).toBe("Black");
  });

  it("rejects malformed JSON without touching history", () => {
    const h0 = createHistory();
    const { history, error } = applyHomescreenInstruction(h0, {
      op: "edit",
      sceneJson: "{ not json ",
    });
    expect(error).toMatch(/valid JSON/);
    expect(history).toBe(h0);
  });

  it("rejects a document that fails validation", () => {
    const h0 = createHistory();
    const { history, error } = applyHomescreenInstruction(h0, {
      op: "create",
      sceneJson: JSON.stringify({ theme: {} }), // no background
    });
    expect(error).toBeTruthy();
    expect(history).toBe(h0);
  });

  it("rejects an edit with no document", () => {
    const h0 = createHistory();
    const { error } = applyHomescreenInstruction(h0, { op: "edit" });
    expect(error).toMatch(/no scene document/);
  });

  it("applies undo / redo", () => {
    let h = createHistory();
    h = applyHomescreenInstruction(h, { op: "edit", sceneJson: VALID }).history;
    h = applyHomescreenInstruction(h, { op: "undo" }).history;
    expect(currentScene(h).id).toBe(createDefaultScene().id);
    h = applyHomescreenInstruction(h, { op: "redo" }).history;
    expect(currentScene(h).name).toBe("Black");
  });

  it("applies reset", () => {
    let h = createHistory();
    h = applyHomescreenInstruction(h, { op: "edit", sceneJson: VALID }).history;
    h = applyHomescreenInstruction(h, { op: "reset" }).history;
    expect(currentScene(h).id).toBe("default");
  });

  it("treats save as a no-op", () => {
    const h0 = createHistory();
    expect(applyHomescreenInstruction(h0, { op: "save" }).history).toBe(h0);
  });
});
