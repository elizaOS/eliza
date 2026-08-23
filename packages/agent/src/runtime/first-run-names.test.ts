/**
 * Deterministic coverage for the first-run agent name pool: constant pool
 * shape, default-name ordering, clamping, uniqueness, and pool-size bounds.
 * The shuffle uses Math.random, so uniqueness and bounds are asserted
 * statistically over many draws.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_POOL,
  DEFAULT_AGENT_NAME,
  pickRandomNames,
} from "./first-run-names.ts";

describe("first-run-names pool", () => {
  it("exposes the default agent name first", () => {
    expect(DEFAULT_AGENT_NAME).toBe("Eliza");
    expect(AGENT_NAME_POOL[0]).toBe(DEFAULT_AGENT_NAME);
  });

  it("keeps the pool non-empty and unique", () => {
    expect(AGENT_NAME_POOL.length).toBeGreaterThan(10);
    expect(new Set(AGENT_NAME_POOL).size).toBe(AGENT_NAME_POOL.length);
  });

  it("returns an empty list for non-positive counts", () => {
    expect(pickRandomNames(0)).toEqual([]);
    expect(pickRandomNames(-3)).toEqual([]);
  });

  it("always keeps the default agent name first", () => {
    for (let i = 0; i < 50; i += 1) {
      const names = pickRandomNames(5);
      expect(names[0]).toBe(DEFAULT_AGENT_NAME);
      expect(names.length).toBe(5);
    }
  });

  it("returns unique names for a draw", () => {
    for (let i = 0; i < 50; i += 1) {
      const names = pickRandomNames(10);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("clamps counts above the pool size to the pool length", () => {
    const names = pickRandomNames(AGENT_NAME_POOL.length + 10);
    expect(names.length).toBe(AGENT_NAME_POOL.length);
    expect(new Set(names).size).toBe(AGENT_NAME_POOL.length);
  });
});
