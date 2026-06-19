import { describe, expect, it } from "vitest";
import { resolvePull } from "./use-pull-gesture";

const DIST = 56;
const VEL = 0.5;

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
