/**
 * Unit tests for the Ai Qa Review Lib app audit helper used by visual review
 * evidence.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateVerdicts,
  buildReviewPrompt,
  gateFailures,
  imageBlock,
  parseVisionVerdict,
} from "../../../../scripts/ai-qa/review-lib.mjs";

describe("buildReviewPrompt (#9304 vision screenshot review)", () => {
  it("names the page + viewport + theme and asks for the strict JSON shape", () => {
    const p = buildReviewPrompt({
      label: "Chat",
      path: "/chat",
      viewport: "mobile",
      theme: "dark",
      issues: ["console.error: boom"],
    });
    expect(p).toContain('"Chat"');
    expect(p).toContain("/chat");
    expect(p).toContain("mobile");
    expect(p).toContain("dark");
    // brand + render-failure + the exact response contract are all instructed
    expect(p).toMatch(/NO blue/);
    expect(p).toContain('"verdict"');
    expect(p).toContain('"brandViolations"');
    expect(p).toContain("console.error: boom");
  });
  it("states there were no errors when none recorded", () => {
    expect(
      buildReviewPrompt({
        label: "X",
        path: "/x",
        viewport: "desktop",
        theme: "light",
      }),
    ).toContain("no console/page errors");
  });
});

describe("parseVisionVerdict", () => {
  it("parses a clean verdict object", () => {
    const v = parseVisionVerdict(
      '{"verdict":"needs-work","reasons":["blue button"],"layoutIssues":[],"brandViolations":["blue accent"],"detectedText":"Save"}',
    );
    expect(v.verdict).toBe("needs-work");
    expect(v.brandViolations).toEqual(["blue accent"]);
    expect(v.detectedText).toBe("Save");
  });
  it("extracts JSON wrapped in prose / code fences", () => {
    const v = parseVisionVerdict(
      'Here is my review:\n```json\n{"verdict":"good"}\n```\nDone.',
    );
    expect(v.verdict).toBe("good");
    expect(v.reasons).toEqual([]); // missing arrays default to []
  });
  it("coerces non-string array members away (no fake precision)", () => {
    const v = parseVisionVerdict(
      '{"verdict":"broken","reasons":["real",42,null,"also"]}',
    );
    expect(v.reasons).toEqual(["real", "also"]);
  });
  it("throws on empty, non-JSON, or an invalid verdict (a failed review is a real signal)", () => {
    expect(() => parseVisionVerdict("")).toThrow();
    expect(() => parseVisionVerdict("no json here")).toThrow();
    expect(() => parseVisionVerdict('{"verdict":"maybe"}')).toThrow(/verdict/);
  });
});

describe("aggregateVerdicts", () => {
  it("tallies verdicts incl. errors", () => {
    expect(
      aggregateVerdicts([
        { verdict: "good" },
        { verdict: "good" },
        { verdict: "needs-work" },
        { verdict: "broken" },
        { error: "HTTP 500" },
      ]),
    ).toEqual({ total: 5, good: 2, "needs-work": 1, broken: 1, error: 1 });
  });
});

describe("gateFailures (debt ratchet + strict mode)", () => {
  const results = [
    { key: "chat-desktop-light", verdict: "good", reasons: [] },
    {
      key: "wallet-mobile-dark",
      verdict: "needs-work",
      reasons: ["blue accent"],
      layoutIssues: [],
      brandViolations: ["blue"],
    },
    { key: "apps-desktop-light", verdict: "broken", reasons: ["blank render"] },
    { key: "files-mobile-light", error: "HTTP 529" },
  ];
  it("fails broken + error by default, not good/needs-work", () => {
    const f = gateFailures(results)
      .map((x) => x.key)
      .sort();
    expect(f).toEqual(["apps-desktop-light", "files-mobile-light"]);
  });
  it("strict mode also fails needs-work", () => {
    const f = gateFailures(results, { strict: true })
      .map((x) => x.key)
      .sort();
    expect(f).toEqual([
      "apps-desktop-light",
      "files-mobile-light",
      "wallet-mobile-dark",
    ]);
  });
  it("the debt allowlist suppresses a known-broken capture (burn-down, not green-wash)", () => {
    const f = gateFailures(results, {
      debt: { "apps-desktop-light": "tracked" },
    }).map((x) => x.key);
    expect(f).toEqual(["files-mobile-light"]);
  });
  it("error failures carry their message as the reason", () => {
    const f = gateFailures([{ key: "x", error: "HTTP 529" }]);
    expect(f[0].verdict).toBe("error");
    expect(f[0].reasons).toEqual(["HTTP 529"]);
  });
});

describe("imageBlock", () => {
  it("builds the Anthropic base64 PNG content block", () => {
    expect(imageBlock("AAAA")).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });
});
