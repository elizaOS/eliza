/**
 * Unit coverage for the pure background undo/redo/set reducer and its history
 * cap. In-memory, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  applyBackgroundRedo,
  applyBackgroundSet,
  applyBackgroundUndo,
  type BackgroundHistoryState,
  MAX_BACKGROUND_HISTORY,
} from "../background-history";
import type { BackgroundConfig } from "../ui-preferences";

const shader = (color: string): BackgroundConfig => ({ mode: "shader", color });

const start = (color = "#ef5a1f"): BackgroundHistoryState => ({
  config: shader(color),
  history: [],
  redo: [],
});

describe("background-history — pure undo/redo reducer (#10694)", () => {
  it("set pushes the outgoing config onto history and clears redo", () => {
    const s1 = applyBackgroundSet(start("#000000"), shader("#059669"));
    expect(s1.config.color).toBe("#059669");
    expect(s1.history.map((c) => c.color)).toEqual(["#000000"]);
    expect(s1.redo).toEqual([]);
  });

  it("setting the identical config is a no-op (same reference, no churn)", () => {
    const s0 = start("#059669");
    expect(applyBackgroundSet(s0, shader("#059669"))).toBe(s0);
  });

  it("undo restores + pushes the undone config onto redo; redo reverses it", () => {
    let s = applyBackgroundSet(start("#000000"), shader("#059669"));
    s = applyBackgroundSet(s, shader("#e11d48"));
    s = applyBackgroundUndo(s);
    expect(s.config.color).toBe("#059669");
    expect(s.redo.map((c) => c.color)).toEqual(["#e11d48"]);
    s = applyBackgroundRedo(s);
    expect(s.config.color).toBe("#e11d48");
    expect(s.redo).toEqual([]);
  });

  it("a fresh set after an undo clears the redo future", () => {
    let s = applyBackgroundSet(start("#000000"), shader("#059669"));
    s = applyBackgroundUndo(s);
    expect(s.redo.length).toBe(1);
    s = applyBackgroundSet(s, shader("#2563eb"));
    expect(s.redo).toEqual([]);
  });

  it("undo/redo are no-ops on empty stacks", () => {
    const s0 = start();
    expect(applyBackgroundUndo(s0)).toBe(s0);
    expect(applyBackgroundRedo(s0)).toBe(s0);
  });

  it("history and redo are bounded to MAX_BACKGROUND_HISTORY", () => {
    let s = start("#000000");
    for (let i = 0; i < MAX_BACKGROUND_HISTORY + 5; i++) {
      s = applyBackgroundSet(
        s,
        shader(`#0000${(i % 10).toString().repeat(2)}`),
      );
    }
    expect(s.history.length).toBe(MAX_BACKGROUND_HISTORY);
    // Undo everything, then the redo stack is likewise capped.
    for (let i = 0; i < MAX_BACKGROUND_HISTORY + 5; i++)
      s = applyBackgroundUndo(s);
    expect(s.redo.length).toBeLessThanOrEqual(MAX_BACKGROUND_HISTORY);
  });
});
