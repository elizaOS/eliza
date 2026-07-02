import { describe, expect, it } from "vitest";
import {
  expectedRendererRuntimeMode,
  formatStagedRendererLaneError,
  iosLaneRuntimeModeProblem,
  stagedRendererLaneProblems,
} from "./mobile-lane-guard.mjs";

describe("expectedRendererRuntimeMode", () => {
  it("resolves the ios lane policy mode when no env override is set", () => {
    expect(expectedRendererRuntimeMode({ iosRuntimeMode: "local" }, {})).toBe(
      "local",
    );
    expect(
      expectedRendererRuntimeMode({ iosRuntimeMode: "cloud-hybrid" }, {}),
    ).toBe("cloud-hybrid");
  });

  it("lets a pre-set VITE_ELIZA_IOS_RUNTIME_MODE win over the ios policy (mirrors buildWeb)", () => {
    expect(
      expectedRendererRuntimeMode(
        { iosRuntimeMode: "local" },
        { VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid" },
      ),
    ).toBe("cloud-hybrid");
  });

  it("ignores empty/whitespace env overrides", () => {
    expect(
      expectedRendererRuntimeMode(
        { iosRuntimeMode: "local" },
        { VITE_ELIZA_IOS_RUNTIME_MODE: "   " },
      ),
    ).toBe("local");
  });

  it("uses the android policy mode unconditionally (buildWeb passes it verbatim)", () => {
    expect(
      expectedRendererRuntimeMode(
        { androidRuntimeMode: "local" },
        { VITE_ELIZA_ANDROID_RUNTIME_MODE: "cloud" },
      ),
    ).toBe("local");
  });

  it("falls back to ELIZA_RUNTIME_MODE when the policy has no mobile mode", () => {
    expect(
      expectedRendererRuntimeMode({}, { ELIZA_RUNTIME_MODE: "local-safe" }),
    ).toBe("local-safe");
    expect(expectedRendererRuntimeMode({}, {})).toBe(null);
  });
});

describe("iosLaneRuntimeModeProblem", () => {
  it("accepts a clean ios-local lane", () => {
    expect(
      iosLaneRuntimeModeProblem({
        lane: "ios-local",
        resolvedRuntimeMode: "local",
        env: {},
      }),
    ).toBe(null);
  });

  it("refuses an ios-local lane polluted to cloud-hybrid (the #11030 device hang)", () => {
    const problem = iosLaneRuntimeModeProblem({
      lane: "ios-local",
      resolvedRuntimeMode: "cloud-hybrid",
      env: {},
    });
    expect(problem).toMatch(/ios-local lane refused/);
    expect(problem).toMatch(/'cloud-hybrid'/);
    expect(problem).toMatch(/install:ios:cloud:sideload --cloud/);
  });

  it("refuses an ios-local lane with an unset runtime mode", () => {
    expect(
      iosLaneRuntimeModeProblem({
        lane: "ios-local",
        resolvedRuntimeMode: null,
        env: {},
      }),
    ).toMatch(/'unset'/);
  });

  it("honors the explicit escape hatch", () => {
    expect(
      iosLaneRuntimeModeProblem({
        lane: "ios-local",
        resolvedRuntimeMode: "cloud-hybrid",
        env: { ELIZA_IOS_ALLOW_LANE_RUNTIME_MISMATCH: "1" },
      }),
    ).toBe(null);
  });

  it("does not constrain the ios (store/cloud) lane", () => {
    expect(
      iosLaneRuntimeModeProblem({
        lane: "ios",
        resolvedRuntimeMode: "cloud-hybrid",
        env: {},
      }),
    ).toBe(null);
  });
});

describe("stagedRendererLaneProblems", () => {
  const expected = {
    expectedVariant: "direct",
    expectedRuntimeMode: "local",
    expectedTarget: "ios",
  };

  it("passes a conformant staged manifest", () => {
    expect(
      stagedRendererLaneProblems({
        manifest: {
          variant: "direct",
          runtimeMode: "local",
          capacitorTarget: "ios",
        },
        ...expected,
      }),
    ).toEqual([]);
  });

  it("flags a missing staged manifest", () => {
    expect(stagedRendererLaneProblems({ manifest: null, ...expected })).toEqual(
      [
        "staged renderer has no build manifest — cannot verify which lane produced it",
      ],
    );
  });

  it("flags the exact #11030 pollution: a store/cloud-hybrid bundle staged for a local device lane", () => {
    const problems = stagedRendererLaneProblems({
      manifest: {
        variant: "store",
        runtimeMode: "cloud-hybrid",
        capacitorTarget: "ios",
      },
      ...expected,
    });
    expect(problems).toEqual([
      "staged renderer variant is 'store' but this lane builds 'direct'",
      "staged renderer runtimeMode is 'cloud-hybrid' but this lane builds 'local'",
    ]);
    const message = formatStagedRendererLaneError("ios-local", problems);
    expect(message).toMatch(/ios-local: the staged renderer does not match/);
    expect(message).toMatch(/install:ios:cloud:sideload --cloud/);
    expect(message).toMatch(/#11030/);
  });

  it("flags a runtimeMode-only mismatch (store local-release lane vs store cloud lane)", () => {
    const problems = stagedRendererLaneProblems({
      manifest: {
        variant: "store",
        runtimeMode: "cloud-hybrid",
        capacitorTarget: "ios",
      },
      expectedVariant: "store",
      expectedRuntimeMode: "local",
      expectedTarget: "ios",
    });
    expect(problems).toEqual([
      "staged renderer runtimeMode is 'cloud-hybrid' but this lane builds 'local'",
    ]);
  });

  it("flags a missing runtimeMode stamp and a wrong target", () => {
    const problems = stagedRendererLaneProblems({
      manifest: { variant: "direct", capacitorTarget: "android" },
      ...expected,
    });
    expect(problems).toContain(
      "staged renderer runtimeMode is 'unset' but this lane builds 'local'",
    );
    expect(problems).toContain(
      "staged renderer capacitor target is 'android' but this lane builds 'ios'",
    );
  });

  it("skips the runtimeMode check only when no expectation exists", () => {
    expect(
      stagedRendererLaneProblems({
        manifest: {
          variant: "direct",
          runtimeMode: "whatever",
          capacitorTarget: "ios",
        },
        expectedVariant: "direct",
        expectedRuntimeMode: null,
        expectedTarget: "ios",
      }),
    ).toEqual([]);
  });
});
