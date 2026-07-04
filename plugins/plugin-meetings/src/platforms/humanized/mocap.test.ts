import { describe, expect, it } from "vitest";
import { MocapEngine, buildMocapLibrary } from "./mocap.js";
import type { Rect } from "./types.js";

describe("mocap library generation", () => {
  it("produces a non-empty, deterministic library for a fixed seed", () => {
    const a = buildMocapLibrary(0x1234);
    const b = buildMocapLibrary(0x1234);
    expect(a.sequences.length).toBeGreaterThan(50);
    expect(a.sequences.length).toBe(b.sequences.length);
    // First sequence identical across builds with the same seed.
    expect(a.sequences[0].total_dx).toBe(b.sequences[0].total_dx);
    expect(a.sequences[0].total_dy).toBe(b.sequences[0].total_dy);
  });

  it("each generated sequence's summed deltas equal its declared totals", () => {
    const lib = buildMocapLibrary();
    for (const seq of lib.sequences.slice(0, 40)) {
      const dx = seq.movements.reduce((a, m) => a + m.dx, 0);
      const dy = seq.movements.reduce((a, m) => a + m.dy, 0);
      expect(dx).toBe(seq.total_dx);
      expect(dy).toBe(seq.total_dy);
      // Dwell times are positive and bounded (human-plausible per-step).
      for (const m of seq.movements) {
        expect(m.dt).toBeGreaterThan(0);
        expect(m.dt).toBeLessThan(0.1);
      }
    }
  });
});

describe("MocapEngine trajectory selection bounds", () => {
  const engine = new MocapEngine();

  function landsInside(startX: number, startY: number, rect: Rect): boolean {
    const seq =
      engine.findSequenceLandingInRect(startX, startY, rect) ??
      engine.findSequenceWithStretchAndRotation(startX, startY, rect);
    if (!seq) return false;
    const fx = startX + seq.total_dx;
    const fy = startY + seq.total_dy;
    return fx >= rect.left && fx <= rect.right && fy >= rect.top && fy <= rect.bottom;
  }

  it("lands the pointer inside a target rect in several directions", () => {
    const start = { x: 400, y: 400 };
    const targets: Rect[] = [
      { left: 690, top: 390, right: 730, bottom: 430 }, // right
      { left: 120, top: 380, right: 160, bottom: 420 }, // left
      { left: 380, top: 700, right: 420, bottom: 740 }, // down
      { left: 380, top: 120, right: 420, bottom: 160 }, // up
    ];
    for (const rect of targets) {
      expect(landsInside(start.x, start.y, rect)).toBe(true);
    }
  });

  it("expands the base library with rotational perturbations", () => {
    const base = buildMocapLibrary().sequences.length;
    expect(engine.size).toBeGreaterThan(base);
  });
});
