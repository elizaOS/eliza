/**
 * Unit coverage for the pure logic of the live visual-QA sweep: the seed the
 * renderer reads to skip onboarding, the state matrix, and the no-blue verdict
 * fold. The capture/analyze shell is not exercised here (it needs a running
 * server + Chromium); these are the decision functions a broken change would
 * silently corrupt.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateVerdict,
  buildCaptureUrl,
  buildOnboardedSeed,
  buildOverallVerdict,
  buildStateMatrix,
  COMPOSER_PROBE_TEXT,
  evaluateCaptureReadiness,
  FIRST_RUN_COMPLETE_KEY,
  STEWARD_SESSION_TOKEN_KEY,
  seedDriftOffenders,
} from "./visual-qa-live.mjs";

describe("buildOnboardedSeed", () => {
  it("sets both keys the renderer gates on and a decodable-but-unsigned JWT", () => {
    const seed = buildOnboardedSeed();
    expect(seed[FIRST_RUN_COMPLETE_KEY]).toBe("1");
    const token = seed[STEWARD_SESSION_TOKEN_KEY];
    const [header, payload, sig] = token.split(".");
    expect(sig).toBe("unsigned"); // never passes real API auth — surfaces the error state
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    expect(claims.sub).toBe("visual-qa-user");
    expect(JSON.parse(Buffer.from(header, "base64").toString("utf8")).alg).toBe(
      "none",
    );
  });

  it("honours a custom subject", () => {
    const token = buildOnboardedSeed({ subject: "elderly-dot" })[
      STEWARD_SESSION_TOKEN_KEY
    ];
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString("utf8"),
    );
    expect(claims.sub).toBe("elderly-dot");
  });
});

describe("buildStateMatrix", () => {
  const matrix = buildStateMatrix();
  it("covers both viewports with fresh first-run and onboarded shell profiles", () => {
    expect(
      matrix.some((s) => s.id === "desktop-onboarding" && s.seed === "fresh"),
    ).toBe(true);
    expect(
      matrix.some((s) => s.id === "mobile-shell" && s.seed === "onboarded"),
    ).toBe(true);
  });
  it("attaches DOM expectations so nonblank-but-wrong screens fail", () => {
    expect(
      matrix.find((s) => s.id === "desktop-onboarding")
        ?.expectedAnyTextIncludes,
    ).toEqual(
      expect.arrayContaining(["Swipe for apps", "Sign in to Eliza Cloud"]),
    );
    expect(
      matrix.find((s) => s.id === "desktop-shell")?.expectedAnyTextIncludes,
    ).toEqual(expect.arrayContaining(["Settings", "Backend Unreachable"]));
    expect(
      matrix.find((s) => s.id === "mobile-chat")?.expectedAnyTextIncludes,
    ).toEqual(expect.arrayContaining(["Pull chat up", "Backend Unreachable"]));
  });
  it("only exercises the keyboard-adjacent composer on mobile", () => {
    const focused = matrix.filter((s) => s.focusComposer);
    expect(focused).toHaveLength(2);
    expect(focused.every((s) => s.viewport === "mobile")).toBe(true);
    expect(focused.map((s) => s.id)).toEqual([
      "mobile-onboarding-composer-focused",
      "mobile-composer-focused",
    ]);
    expect(focused.map((s) => s.seed)).toEqual(["fresh", "onboarded"]);
    expect(focused.map((s) => s.route)).toEqual(["/", "/chat"]);
  });
  it("gives every state a unique id", () => {
    const ids = matrix.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildCaptureUrl", () => {
  it("joins routes against a base with or without a trailing slash", () => {
    expect(buildCaptureUrl("http://127.0.0.1:2138", "/views")).toBe(
      "http://127.0.0.1:2138/views",
    );
    expect(buildCaptureUrl("http://127.0.0.1:2138/", "/chat")).toBe(
      "http://127.0.0.1:2138/chat",
    );
  });
});

describe("aggregateVerdict", () => {
  it("passes when every state is under the blue ceiling", () => {
    const v = aggregateVerdict([
      { id: "a", color_fractions: { blue_fraction: 0 } },
      { id: "b", color_fractions: { blue_fraction: 0.01 } },
    ]);
    expect(v.pass).toBe(true);
    expect(v.offenders).toEqual([]);
  });
  it("fails and names the offending state when blue exceeds the ceiling", () => {
    const v = aggregateVerdict([
      { id: "clean", color_fractions: { blue_fraction: 0.0 } },
      { id: "bluish", color_fractions: { blue_fraction: 0.15 } },
    ]);
    expect(v.pass).toBe(false);
    expect(v.offenders.map((o) => o.id)).toEqual(["bluish"]);
  });
  it("fails closed when a capture has no measured blue fraction", () => {
    const v = aggregateVerdict([{ id: "x" }]);
    expect(v.pass).toBe(false);
    expect(v.offenders).toEqual([
      { id: "x", blue: null, reason: "blue_fraction not measured" },
    ]);
  });
});

describe("seedDriftOffenders", () => {
  it("passes when the seeded shell differs materially from the first-run surface", () => {
    expect(
      seedDriftOffenders([
        { viewport: "desktop", changedFraction: 0.41 },
        { viewport: "mobile", changedFraction: 0.35 },
      ]),
    ).toEqual([]);
  });
  it("flags a viewport whose seeded shell re-rendered the first-run surface", () => {
    const offenders = seedDriftOffenders([
      { viewport: "desktop", changedFraction: 0.41 },
      { viewport: "mobile", changedFraction: 0.001 },
    ]);
    expect(offenders).toEqual([{ viewport: "mobile", changedFraction: 0.001 }]);
  });
  it("treats an unmeasured delta as drift, never as a pass", () => {
    expect(seedDriftOffenders([{ viewport: "desktop" }])).toEqual([
      { viewport: "desktop", changedFraction: undefined },
    ]);
  });
  it("preserves the reason when a seed-drift measurement could not run", () => {
    expect(
      seedDriftOffenders([
        {
          viewport: "desktop",
          changedFraction: undefined,
          reason: "missing onboarding or shell capture",
        },
      ]),
    ).toEqual([
      {
        viewport: "desktop",
        changedFraction: undefined,
        reason: "missing onboarding or shell capture",
      },
    ]);
  });
});

describe("buildOverallVerdict", () => {
  it("passes only when color, capture readiness, and seed drift all pass", () => {
    expect(
      buildOverallVerdict({
        colorVerdict: { pass: true },
        captureFailures: [],
        driftOffenders: [],
      }).pass,
    ).toBe(true);
  });

  it("fails when a capture is invalid even if color analysis passes", () => {
    const verdict = buildOverallVerdict({
      colorVerdict: { pass: true },
      captureFailures: [
        {
          id: "mobile-composer-focused",
          failedChecks: [{ name: "composer:focus_and_type", ok: false }],
        },
      ],
      driftOffenders: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.colorPass).toBe(true);
    expect(verdict.captureFailures.map((f) => f.id)).toEqual([
      "mobile-composer-focused",
    ]);
  });

  it("fails when the onboarded seed drifts back to the first-run surface", () => {
    const verdict = buildOverallVerdict({
      colorVerdict: { pass: true },
      captureFailures: [],
      driftOffenders: [{ viewport: "mobile", changedFraction: 0.001 }],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.driftOffenders.map((o) => o.viewport)).toEqual(["mobile"]);
  });
});

describe("evaluateCaptureReadiness", () => {
  it("passes for a nonblank state with visible DOM text", () => {
    const v = evaluateCaptureReadiness({
      state: { id: "desktop-shell" },
      domText: "Backend Unreachable Try again",
    });
    expect(v.pass).toBe(true);
  });

  it("requires each expected text fragment for state-specific captures", () => {
    const state = {
      id: "desktop-onboarding",
      expectedTextIncludes: ["Swipe for apps", "Pull chat up"],
    };
    expect(
      evaluateCaptureReadiness({
        state,
        domText: "Good night. Swipe for apps. Pull chat up.",
      }).pass,
    ).toBe(true);
    const v = evaluateCaptureReadiness({
      state,
      domText: "Good night. Ask Dev Smoke.",
    });
    expect(v.pass).toBe(false);
    expect(v.checks.filter((c) => c.name === "dom:expected_text")).toEqual([
      {
        name: "dom:expected_text",
        ok: false,
        detail: 'visible DOM text does not contain "Swipe for apps"',
      },
      {
        name: "dom:expected_text",
        ok: false,
        detail: 'visible DOM text does not contain "Pull chat up"',
      },
    ]);
  });

  it("accepts any one of the configured degraded chat surfaces", () => {
    const state = {
      id: "mobile-chat",
      expectedAnyTextIncludes: ["Pull chat up", "Backend Unreachable"],
    };
    expect(
      evaluateCaptureReadiness({
        state,
        domText: "Startup failed: Backend Unreachable. Open App.",
      }).pass,
    ).toBe(true);
    const v = evaluateCaptureReadiness({
      state,
      domText: "Settings Wallet Tasks",
    });
    expect(v.pass).toBe(false);
    expect(v.checks).toContainEqual({
      name: "dom:expected_any_text",
      ok: false,
      detail:
        'visible DOM text does not contain any of "Pull chat up", "Backend Unreachable"',
    });
  });

  it("fails blank captures before color heuristics can hide them", () => {
    const v = evaluateCaptureReadiness({
      state: { id: "desktop-shell" },
      domText: "   ",
    });
    expect(v.pass).toBe(false);
    expect(v.checks.map((c) => c.name)).toContain("dom:not_blank");
  });

  it("requires the mobile composer probe to survive focus and typing", () => {
    const state = {
      id: "mobile-composer-focused",
      expectedComposerText: COMPOSER_PROBE_TEXT,
    };
    expect(
      evaluateCaptureReadiness({
        state,
        domText: "Sign in to Eliza Cloud",
        composerText: COMPOSER_PROBE_TEXT,
      }).pass,
    ).toBe(true);
    expect(
      evaluateCaptureReadiness({
        state,
        domText: "Sign in to Eliza Cloud",
        composerText: "",
      }).pass,
    ).toBe(false);
  });
});
