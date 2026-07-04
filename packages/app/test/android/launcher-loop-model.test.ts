// Unit coverage for the seeded launcher-loop model that drives both mobile-native
// lanes (#12377). Deterministic and jsdom-free: proves a seed reproduces the
// exact action stream (the ELIZA_LOOP_SEED reproduction contract) and that the
// pure page transitions match the launcher's real single-page rail semantics.
import { describe, expect, it } from "vitest";
import {
  generateLauncherLoop,
  type LauncherLoopActionKind,
  nextPage,
  resolveLoopSeed,
  SeededRandom,
} from "./launcher-loop-model";

describe("SeededRandom", () => {
  it("is deterministic for a given seed", () => {
    const a = new SeededRandom(12345);
    const b = new SeededRandom(12345);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("diverges for different seeds", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("emits floats in [0, 1)", () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("bounds ints to [0, bound)", () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.int(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
  });
});

describe("nextPage", () => {
  it("commits toward the launcher on a full left swipe from either page", () => {
    expect(nextPage("swipe-left", "home")).toBe("launcher");
    expect(nextPage("swipe-left", "launcher")).toBe("launcher");
  });

  it("commits toward home on a full right swipe from either page", () => {
    expect(nextPage("swipe-right", "home")).toBe("home");
    expect(nextPage("swipe-right", "launcher")).toBe("home");
  });

  it("leaves the page unchanged for non-committing actions", () => {
    const nonCommitting: LauncherLoopActionKind[] = [
      "sub-threshold-swipe-left",
      "sub-threshold-swipe-right",
      "vertical-scroll",
      "tap-center",
    ];
    for (const kind of nonCommitting) {
      expect(nextPage(kind, "home")).toBe("home");
      expect(nextPage(kind, "launcher")).toBe("launcher");
    }
  });
});

describe("generateLauncherLoop", () => {
  it("reproduces the exact action stream for a seed", () => {
    const seed = 0xc0ffee;
    const a = generateLauncherLoop(seed, 200);
    const b = generateLauncherLoop(seed, 200);
    expect(a).toEqual(b);
  });

  it("threads the modelled page so expectedPageAfter is self-consistent", () => {
    const actions = generateLauncherLoop(42, 500);
    let page: "home" | "launcher" = "home";
    for (const action of actions) {
      page = nextPage(action.kind, page);
      expect(action.expectedPageAfter).toBe(page);
    }
  });

  it("produces the requested number of actions", () => {
    expect(generateLauncherLoop(1, 200)).toHaveLength(200);
    expect(generateLauncherLoop(1, 1)).toHaveLength(1);
  });

  it("exercises every action kind across a long loop", () => {
    const kinds = new Set(generateLauncherLoop(5, 2000).map((a) => a.kind));
    expect(kinds).toEqual(
      new Set([
        "swipe-left",
        "swipe-right",
        "sub-threshold-swipe-left",
        "sub-threshold-swipe-right",
        "vertical-scroll",
        "tap-center",
      ]),
    );
  });

  it("rejects a non-positive action count", () => {
    expect(() => generateLauncherLoop(1, 0)).toThrow(/positive integer/);
    expect(() => generateLauncherLoop(1, -5)).toThrow(/positive integer/);
  });

  it("honors the start page", () => {
    // A loop whose first action is a right-swipe from home leaves the rail on
    // home; from launcher the same first action still lands home. Seed 3's first
    // pick is deterministic, so assert the transition, not a fixed value.
    const fromHome = generateLauncherLoop(3, 1, "home");
    const fromLauncher = generateLauncherLoop(3, 1, "launcher");
    expect(fromHome[0].kind).toBe(fromLauncher[0].kind);
    expect(fromHome[0].expectedPageAfter).toBe(
      nextPage(fromHome[0].kind, "home"),
    );
    expect(fromLauncher[0].expectedPageAfter).toBe(
      nextPage(fromLauncher[0].kind, "launcher"),
    );
  });
});

describe("resolveLoopSeed", () => {
  it("honors an explicit integer ELIZA_LOOP_SEED", () => {
    expect(
      resolveLoopSeed({ ELIZA_LOOP_SEED: "777" } as NodeJS.ProcessEnv),
    ).toBe(777);
  });

  it("throws on a non-integer ELIZA_LOOP_SEED", () => {
    expect(() =>
      resolveLoopSeed({ ELIZA_LOOP_SEED: "not-a-number" } as NodeJS.ProcessEnv),
    ).toThrow(/must be an integer/);
  });

  it("returns a positive seed when unset", () => {
    const seed = resolveLoopSeed({} as NodeJS.ProcessEnv);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });
});
