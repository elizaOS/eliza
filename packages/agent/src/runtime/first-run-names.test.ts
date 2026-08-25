/**
 * Behavioral coverage for the first-run agent name pool and pickRandomNames.
 * Drives the real module: default-first ordering, uniqueness, empty and
 * single-element selection, clamp/overflow, and Fisher-Yates shuffle edges.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_NAME_POOL,
  DEFAULT_AGENT_NAME,
  pickRandomNames,
} from "./first-run-names.ts";

const RANDOM_AGENT_NAMES = AGENT_NAME_POOL.slice(1);

describe("first-run-names", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports Eliza as the default first-run agent name", () => {
    expect(DEFAULT_AGENT_NAME).toBe("Eliza");
  });

  it("keeps the default name first in the published pool and lists each name once", () => {
    expect(AGENT_NAME_POOL[0]).toBe(DEFAULT_AGENT_NAME);
    expect(AGENT_NAME_POOL).toEqual([
      "Eliza",
      "Reimu",
      "Sakuya",
      "Yukari",
      "Marisa",
      "Youmu",
      "Koakuma",
      "Reisen",
      "Yuyuko",
      "Aya",
      "Ran",
      "Sanae",
      "Suika",
      "Koishi",
      "Nue",
      "Mokou",
      "Satori",
      "Remilia",
      "Suwako",
      "Momiji",
      "Tenshi",
      "Kaguya",
      "Komachi",
      "Nitori",
      "Charlotte",
      "Kasen",
      "Mima",
      "Yuuka",
      "Kogasa",
      "Rin",
      "Tewi",
      "Eirin",
      "Hina",
      "Kagerou",
      "Sumireko",
      "Kokoro",
      "Mamizou",
      "Rinnosuke",
      "Yumemi",
      "Akyuu",
      "Kanako",
      "Hatsune",
      "Shinki",
      "Shion",
      "Daiyousei",
      "Iku",
      "Miya",
      "Mai",
      "Meira",
      "Murasa",
      "Usagi",
      "Rei",
      "Yumi",
      "Miku",
      "Kira",
    ]);
    expect(new Set(AGENT_NAME_POOL).size).toBe(AGENT_NAME_POOL.length);
    expect(RANDOM_AGENT_NAMES).not.toContain(DEFAULT_AGENT_NAME);
  });

  it("returns an empty list when count is zero or negative", () => {
    expect(pickRandomNames(0)).toEqual([]);
    expect(pickRandomNames(-1)).toEqual([]);
    expect(pickRandomNames(-100)).toEqual([]);
    expect(pickRandomNames(Number.NEGATIVE_INFINITY)).toEqual([]);
  });

  it("returns only the default name for a single-element request", () => {
    expect(pickRandomNames(1)).toEqual([DEFAULT_AGENT_NAME]);
  });

  it("keeps the default name first and fills the rest with unique pool members", () => {
    const names = pickRandomNames(4);
    expect(names).toHaveLength(4);
    expect(names[0]).toBe(DEFAULT_AGENT_NAME);
    expect(new Set(names).size).toBe(4);
    expect(AGENT_NAME_POOL).toEqual(expect.arrayContaining(names));
    expect(names.slice(1)).not.toContain(DEFAULT_AGENT_NAME);
  });

  it("clamps overflow to the full pool and still keeps the default name first", () => {
    const overflow = pickRandomNames(AGENT_NAME_POOL.length + 25);
    expect(overflow).toHaveLength(AGENT_NAME_POOL.length);
    expect(overflow[0]).toBe(DEFAULT_AGENT_NAME);
    expect(new Set(overflow)).toEqual(new Set(AGENT_NAME_POOL));
  });

  it("returns every pool name exactly once when count equals pool capacity", () => {
    const names = pickRandomNames(AGENT_NAME_POOL.length);
    expect(names).toHaveLength(AGENT_NAME_POOL.length);
    expect(names[0]).toBe(DEFAULT_AGENT_NAME);
    expect(new Set(names)).toEqual(new Set(AGENT_NAME_POOL));
  });

  it("does not mutate the published pool and returns a fresh array each call", () => {
    const snapshot = [...AGENT_NAME_POOL];
    const first = pickRandomNames(5);
    const second = pickRandomNames(5);
    first.push("not-a-pool-name");
    expect(AGENT_NAME_POOL).toEqual(snapshot);
    expect(second).not.toBe(first);
    expect(second).not.toContain("not-a-pool-name");
  });

  it("skips shuffling when the clamped count is empty and shuffles otherwise", () => {
    const spy = vi.spyOn(Math, "random");
    expect(pickRandomNames(0)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockClear();
    pickRandomNames(1);
    expect(spy.mock.calls.length).toBe(RANDOM_AGENT_NAMES.length - 1);
  });

  it("rotates the random pool left by one when Math.random is always 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickRandomNames(4)).toEqual([
      DEFAULT_AGENT_NAME,
      RANDOM_AGENT_NAMES[1],
      RANDOM_AGENT_NAMES[2],
      RANDOM_AGENT_NAMES[3],
    ]);
  });

  it("keeps random-pool order when Math.random always selects the current index", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999999999);
    expect(pickRandomNames(4)).toEqual([
      DEFAULT_AGENT_NAME,
      RANDOM_AGENT_NAMES[0],
      RANDOM_AGENT_NAMES[1],
      RANDOM_AGENT_NAMES[2],
    ]);
  });

  it("treats fractional counts below 2 as a single default-name result", () => {
    expect(pickRandomNames(0.5)).toEqual([DEFAULT_AGENT_NAME]);
    expect(pickRandomNames(1.9)).toEqual([DEFAULT_AGENT_NAME]);
  });

  it("treats NaN as a single default-name result and Infinity as the full pool", () => {
    expect(pickRandomNames(Number.NaN)).toEqual([DEFAULT_AGENT_NAME]);
    const infinite = pickRandomNames(Number.POSITIVE_INFINITY);
    expect(infinite).toHaveLength(AGENT_NAME_POOL.length);
    expect(infinite[0]).toBe(DEFAULT_AGENT_NAME);
    expect(new Set(infinite)).toEqual(new Set(AGENT_NAME_POOL));
  });

  it("actually permutes the non-default names across independent draws", () => {
    const seconds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const names = pickRandomNames(3);
      expect(names[0]).toBe(DEFAULT_AGENT_NAME);
      const second = names[1];
      expect(typeof second).toBe("string");
      if (second !== undefined) {
        seconds.add(second);
      }
    }
    expect(seconds.size).toBeGreaterThan(1);
  });
});
