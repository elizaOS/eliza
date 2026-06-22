import { describe, expect, it } from "vitest";
import { resolvePull, resolveSwipe } from "./use-pull-gesture";

const DIST = 56;
const VEL = 0.5;
const DIST_X = 64;
const VEL_X = 0.4;

describe("resolvePull", () => {
  it("fires up on a long upward drag", () => {
    expect(resolvePull(80, 0.05, DIST, VEL)).toBe("up");
  });

  it("fires down on a long downward drag", () => {
    expect(resolvePull(-80, -0.05, DIST, VEL)).toBe("down");
  });

  it("fires on a fast flick even when the travel is short", () => {
    expect(resolvePull(20, 0.9, DIST, VEL)).toBe("up");
    expect(resolvePull(-20, -0.9, DIST, VEL)).toBe("down");
  });

  it("ignores small, slow movements (taps / jitter)", () => {
    expect(resolvePull(10, 0.1, DIST, VEL)).toBeNull();
    expect(resolvePull(-8, -0.05, DIST, VEL)).toBeNull();
  });
});

describe("resolveSwipe", () => {
  it("fires left on a long leftward drag", () => {
    expect(resolveSwipe(90, 0.05, 5, DIST_X, VEL_X)).toBe("left");
  });

  it("fires right on a long rightward drag", () => {
    expect(resolveSwipe(-90, -0.05, -5, DIST_X, VEL_X)).toBe("right");
  });

  it("fires on a fast horizontal flick even when travel is short", () => {
    expect(resolveSwipe(20, 0.6, 0, DIST_X, VEL_X)).toBe("left");
    expect(resolveSwipe(-20, -0.6, 0, DIST_X, VEL_X)).toBe("right");
  });

  it("does NOT fire when the gesture is mostly vertical (no axis clash)", () => {
    // Large horizontal travel but even larger vertical travel → vertical wins.
    expect(resolveSwipe(80, 0.1, 120, DIST_X, VEL_X)).toBeNull();
    expect(resolveSwipe(70, 0.5, -90, DIST_X, VEL_X)).toBeNull();
  });

  it("ignores small, slow horizontal movements", () => {
    expect(resolveSwipe(12, 0.1, 2, DIST_X, VEL_X)).toBeNull();
  });
});
