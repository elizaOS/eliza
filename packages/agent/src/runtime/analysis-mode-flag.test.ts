import { describe, expect, it } from "vitest";

import {
  AnalysisModeFlagStore,
  isAnalysisModeAllowed,
  parseAnalysisToken,
} from "./analysis-mode-flag.js";

describe("parseAnalysisToken", () => {
  it("recognizes the bare 'analysis' token", () => {
    expect(parseAnalysisToken("analysis")).toBe("enable");
    expect(parseAnalysisToken("Analysis")).toBe("enable");
    expect(parseAnalysisToken("  ANALYSIS  ")).toBe("enable");
  });

  it("recognizes the 'as you were' shutoff", () => {
    expect(parseAnalysisToken("as you were")).toBe("disable");
    expect(parseAnalysisToken("As You Were")).toBe("disable");
    expect(parseAnalysisToken("  as   you  were ")).toBe("disable");
  });

  it("ignores normal sentences containing the words", () => {
    expect(parseAnalysisToken("can you do an analysis of this?")).toBeNull();
    expect(parseAnalysisToken("as you were saying")).toBeNull();
    expect(parseAnalysisToken("analysis: foo")).toBeNull();
    expect(parseAnalysisToken("")).toBeNull();
    expect(parseAnalysisToken(undefined)).toBeNull();
    expect(parseAnalysisToken(null)).toBeNull();
  });

  it("treats tabs and newlines around the token as whitespace", () => {
    expect(parseAnalysisToken("\tanalysis\n")).toBe("enable");
    expect(parseAnalysisToken("\nas you were\t")).toBe("disable");
    // Newlines inside the token (separating words) still count as \s for the
    // 'as you were' regex — that is the documented strict-grammar behaviour.
    expect(parseAnalysisToken("as\nyou\twere")).toBe("disable");
  });

  it("rejects analysis embedded next to other characters", () => {
    expect(parseAnalysisToken("analysis!")).toBeNull();
    expect(parseAnalysisToken("(analysis)")).toBeNull();
    expect(parseAnalysisToken("analysisanalysis")).toBeNull();
    expect(parseAnalysisToken("as-you-were")).toBeNull();
  });
});

describe("AnalysisModeFlagStore", () => {
  it("toggles per-room state independently", () => {
    const store = new AnalysisModeFlagStore();
    expect(store.isEnabled("room-a")).toBe(false);

    store.enable("room-a");
    expect(store.isEnabled("room-a")).toBe(true);
    expect(store.isEnabled("room-b")).toBe(false);

    store.disable("room-a");
    expect(store.isEnabled("room-a")).toBe(false);
  });

  it("applyToken honors enable/disable/null", () => {
    const store = new AnalysisModeFlagStore();
    expect(store.applyToken("r1", "enable")).toBe(true);
    expect(store.applyToken("r1", null)).toBe(true); // unchanged read
    expect(store.applyToken("r1", "disable")).toBe(false);
  });

  it("auto-expires after ttl", () => {
    let now = 1_000_000;
    const store = new AnalysisModeFlagStore({
      ttlMs: 5_000,
      now: () => now,
    });
    store.enable("room-x");
    expect(store.isEnabled("room-x")).toBe(true);

    now += 4_999;
    expect(store.isEnabled("room-x")).toBe(true);

    now += 2;
    expect(store.isEnabled("room-x")).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("treats expiresAt === now as expired (boundary)", () => {
    let now = 1_000_000;
    const store = new AnalysisModeFlagStore({
      ttlMs: 5_000,
      now: () => now,
    });
    store.enable("room-x");
    now += 5_000; // exactly at expiry boundary
    expect(store.isEnabled("room-x")).toBe(false);
  });

  it("re-enabling resets the expiry window", () => {
    let now = 1_000_000;
    const store = new AnalysisModeFlagStore({
      ttlMs: 5_000,
      now: () => now,
    });
    store.enable("room-x");
    now += 4_000;
    store.enable("room-x"); // refresh
    now += 4_000; // 8s after first enable, 4s after refresh
    expect(store.isEnabled("room-x")).toBe(true);
  });

  it("applyToken(null) returns false when nothing is set", () => {
    const store = new AnalysisModeFlagStore();
    expect(store.applyToken("fresh", null)).toBe(false);
  });

  it("clear() empties the store", () => {
    const store = new AnalysisModeFlagStore();
    store.enable("a");
    store.enable("b");
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.isEnabled("a")).toBe(false);
  });

  it("zero or negative ttlMs disables auto-expiry", () => {
    let now = 1_000_000;
    const store = new AnalysisModeFlagStore({
      ttlMs: 0,
      now: () => now,
    });
    store.enable("room-x");
    now += 1_000_000_000;
    expect(store.isEnabled("room-x")).toBe(true);
  });
});

describe("isAnalysisModeAllowed", () => {
  it("explicit env opt-in wins", () => {
    expect(isAnalysisModeAllowed({ MILADY_ENABLE_ANALYSIS_MODE: "1" })).toBe(
      true,
    );
    expect(
      isAnalysisModeAllowed({
        MILADY_ENABLE_ANALYSIS_MODE: "1",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("explicit env opt-out wins over NODE_ENV=development", () => {
    expect(
      isAnalysisModeAllowed({
        MILADY_ENABLE_ANALYSIS_MODE: "0",
        NODE_ENV: "development",
      }),
    ).toBe(false);
  });

  it("falls through to NODE_ENV=development", () => {
    expect(isAnalysisModeAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(isAnalysisModeAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(isAnalysisModeAllowed({})).toBe(false);
  });

  it("rejects production without explicit opt-in", () => {
    // Hard guard against accidental enablement in production deployments.
    expect(isAnalysisModeAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(
      isAnalysisModeAllowed({
        NODE_ENV: "production",
        MILADY_ENABLE_ANALYSIS_MODE: undefined,
      }),
    ).toBe(false);
  });

  it("ignores non-canonical truthy values for the env flag", () => {
    // Only "1" enables; "true"/"yes"/"on" must not. Falls through to NODE_ENV.
    expect(
      isAnalysisModeAllowed({
        MILADY_ENABLE_ANALYSIS_MODE: "true",
        NODE_ENV: "production",
      }),
    ).toBe(false);
    expect(
      isAnalysisModeAllowed({
        MILADY_ENABLE_ANALYSIS_MODE: "yes",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("test/staging NODE_ENV values do not enable analysis mode", () => {
    expect(isAnalysisModeAllowed({ NODE_ENV: "test" })).toBe(false);
    expect(isAnalysisModeAllowed({ NODE_ENV: "staging" })).toBe(false);
  });
});
