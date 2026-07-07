/**
 * Regression tests for the story-gate console/a11y baseline ratchet
 * (`classifyStoryGateFailures` in run-story-gate.mjs), issue #13621 task [2].
 *
 * The bug: `enforceConsole`/`enforceA11y` were gated on
 * `Object.keys(baseline).length > 0`, which INVERTED the ratchet — emptying or
 * resetting a baseline silently DISABLED the check (the opposite of a burn-down
 * ratchet and the opposite of the correct `broken-baseline` sibling where
 * `{}` = zero tolerance). These tests pin the corrected behaviour: the baseline
 * is a pure ALLOWLIST, so an empty/absent baseline fails on ANY violation.
 *
 * Runs in the standard `packages/ui` vitest suite (env: node). Importing the
 * module does not launch a browser — `main()` is guarded behind import.meta.
 */
import { describe, expect, it } from "vitest";
import {
  classifyStoryGateFailures,
  deriveNetworkFailureIssues,
  isCatalogResourceFailure,
} from "./run-story-gate.mjs";

const ORIGIN = "http://127.0.0.1:65000";

describe("isCatalogResourceFailure — only real catalog-bundle 404s escalate", () => {
  it("escalates a same-origin bundle resource 404 (broken build)", () => {
    expect(
      isCatalogResourceFailure(`${ORIGIN}/assets/vite-app.abc123.js`, ORIGIN),
    ).toBe(true);
  });
  it("ignores /api/* — the static catalog has no backend", () => {
    expect(isCatalogResourceFailure(`${ORIGIN}/api/accounts`, ORIGIN)).toBe(
      false,
    );
    expect(
      isCatalogResourceFailure(`${ORIGIN}/api/media/aaaa.glb`, ORIGIN),
    ).toBe(false);
  });
  it("ignores absolute public assets not emitted into storybook-static", () => {
    for (const p of [
      "/brand/logos/eliza_text_white.svg",
      "/logos/anthropic-icon.png",
      "/bg-sunset.webp",
    ]) {
      expect(isCatalogResourceFailure(`${ORIGIN}${p}`, ORIGIN)).toBe(false);
    }
  });
  it("ignores external hosts (sandbox-blocked / third-party)", () => {
    expect(
      isCatalogResourceFailure("https://example.com/clip.mp3", ORIGIN),
    ).toBe(false);
  });
});

describe("deriveNetworkFailureIssues scoping", () => {
  it("does not escalate /api + external + public-asset failures", () => {
    const cap = {
      failedResponses: [
        { status: 404, url: `${ORIGIN}/api/accounts` },
        { status: 404, url: `${ORIGIN}/logos/openai-icon.png` },
      ],
      requestFailures: [
        { failure: "net::ERR_BLOCKED_BY_ORB", url: "https://example.com/x.mp3" },
      ],
    };
    expect(deriveNetworkFailureIssues(cap, "good", ORIGIN).escalate).toBe(false);
  });
  it("still escalates a real same-origin bundle 404", () => {
    const cap = {
      failedResponses: [{ status: 404, url: `${ORIGIN}/assets/chunk.js` }],
      requestFailures: [],
    };
    const r = deriveNetworkFailureIssues(cap, "good", ORIGIN);
    expect(r.escalate).toBe(true);
    expect(r.issues[0]).toContain("chunk.js");
  });
});

/** Minimal per-story result shape the classifier consumes. */
function story(overrides = {}) {
  return {
    id: "acme--widget",
    verdict: "good",
    issues: [],
    consoleErrors: [],
    a11y: [],
    ...overrides,
  };
}

describe("classifyStoryGateFailures console/a11y allowlist ratchet", () => {
  it("REGRESSION: an EMPTY console baseline fails on any console error (was silently disabled)", () => {
    const { failures } = classifyStoryGateFailures({
      results: [story({ consoleErrors: ["TypeError: boom in widget"] })],
      consoleBaseline: {}, // empty allowlist == zero tolerance
      a11yBaseline: {},
      brokenBaseline: {},
    });
    const consoleFailures = failures.filter(
      (f) => f.kind === "new-console-error",
    );
    expect(consoleFailures).toHaveLength(1);
    expect(consoleFailures[0].id).toBe("acme--widget");
  });

  it("REGRESSION: an EMPTY a11y baseline fails on any a11y violation (was silently disabled)", () => {
    const { failures } = classifyStoryGateFailures({
      results: [
        story({ a11y: [{ id: "button-name" }, { id: "color-contrast" }] }),
      ],
      consoleBaseline: {},
      a11yBaseline: {}, // empty allowlist == zero tolerance
      brokenBaseline: {},
    });
    const a11yFailures = failures.filter(
      (f) => f.kind === "new-a11y-violation",
    );
    expect(a11yFailures).toHaveLength(1);
    expect(a11yFailures[0].detail).toContain("button-name");
    expect(a11yFailures[0].detail).toContain("color-contrast");
  });

  it("a violation whose key IS in the allowlist does not fail", () => {
    const { failures } = classifyStoryGateFailures({
      results: [
        story({
          consoleErrors: ["TypeError: boom in widget"],
          a11y: [{ id: "color-contrast" }],
        }),
      ],
      // Allowlist the normalized console key + the a11y rule id.
      consoleBaseline: { "acme--widget": ["TypeError: boom in widget"] },
      a11yBaseline: { "acme--widget": ["color-contrast"] },
      brokenBaseline: {},
    });
    expect(failures).toHaveLength(0);
  });

  it("a NEW violation absent from a POPULATED allowlist still reds (per-key ratchet)", () => {
    const { failures } = classifyStoryGateFailures({
      results: [
        story({
          a11y: [{ id: "color-contrast" }, { id: "button-name" }],
        }),
      ],
      consoleBaseline: { "other--story": ["some old error"] }, // populated but unrelated
      a11yBaseline: { "acme--widget": ["color-contrast"] }, // only one rule allowlisted
      brokenBaseline: {},
    });
    const a11yFailures = failures.filter(
      (f) => f.kind === "new-a11y-violation",
    );
    expect(a11yFailures).toHaveLength(1);
    // Only the un-allowlisted rule is reported; the allowlisted one is filtered.
    expect(a11yFailures[0].detail).toBe("button-name");
  });

  it("broken verdict: allowlisted id is tolerated, un-allowlisted id reds", () => {
    const { failures } = classifyStoryGateFailures({
      results: [
        story({
          id: "known--broken",
          verdict: "broken",
          issues: ["render threw"],
        }),
        story({
          id: "new--broken",
          verdict: "broken",
          issues: ["blank render"],
        }),
      ],
      consoleBaseline: {},
      a11yBaseline: {},
      brokenBaseline: { "known--broken": "render threw" },
    });
    const brokenFailures = failures.filter((f) => f.kind === "broken");
    expect(brokenFailures).toHaveLength(1);
    expect(brokenFailures[0].id).toBe("new--broken");
  });

  it("updateBaseline mode does not push console/a11y failures (regeneration pass)", () => {
    const { failures, newConsoleBaseline, newA11yBaseline } =
      classifyStoryGateFailures({
        results: [
          story({
            consoleErrors: ["TypeError: boom in widget"],
            a11y: [{ id: "button-name" }],
          }),
        ],
        consoleBaseline: {},
        a11yBaseline: {},
        brokenBaseline: {},
        updateBaseline: true,
      });
    expect(failures.filter((f) => f.kind === "new-console-error")).toHaveLength(
      0,
    );
    expect(
      failures.filter((f) => f.kind === "new-a11y-violation"),
    ).toHaveLength(0);
    // But the regenerated baselines still capture what it saw.
    expect(newConsoleBaseline["acme--widget"]).toEqual([
      "TypeError: boom in widget",
    ]);
    expect(newA11yBaseline["acme--widget"]).toEqual(["button-name"]);
  });

  it("a clean story with no violations produces no failures", () => {
    const { failures } = classifyStoryGateFailures({
      results: [story()],
      consoleBaseline: {},
      a11yBaseline: {},
      brokenBaseline: {},
    });
    expect(failures).toHaveLength(0);
  });

  it("de-duplicates repeated console keys into the regenerated baseline", () => {
    const { newConsoleBaseline } = classifyStoryGateFailures({
      results: [
        story({
          consoleErrors: ["boom", "boom", "boom"],
        }),
      ],
      consoleBaseline: { "acme--widget": ["boom"] },
      a11yBaseline: {},
      brokenBaseline: {},
    });
    expect(newConsoleBaseline["acme--widget"]).toEqual(["boom"]);
  });
});
