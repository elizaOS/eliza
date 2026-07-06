// Walkthrough definition schema validation. Pure and tool-free (always runs):
// asserts valid definitions parse, and that malformed ones — unknown action,
// missing required selector/value, empty step list, bad slug — throw a typed
// EvidenceValidationError carrying per-field issues, never a silently-repaired
// definition. Also validates every shipped definition file against the schema.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceValidationError } from "../errors.ts";
import { parseWalkthroughDef } from "./walkthrough-schema.ts";
import { WALKTHROUGHS_DIR } from "./walkthroughs.ts";

describe("parseWalkthroughDef", () => {
  it("accepts a minimal valid definition", () => {
    const def = parseWalkthroughDef(
      {
        slug: "ok",
        granularity: "feature",
        steps: [{ action: "goto", value: "/" }],
      },
      "test",
    );
    expect(def.slug).toBe("ok");
    expect(def.steps).toHaveLength(1);
  });

  it("rejects an unknown action with a typed error", () => {
    expect(() =>
      parseWalkthroughDef(
        { slug: "x", granularity: "feature", steps: [{ action: "teleport" }] },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects a click with no selector", () => {
    try {
      parseWalkthroughDef(
        { slug: "x", granularity: "element", steps: [{ action: "click" }] },
        "test",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      expect((error as EvidenceValidationError).issues.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("rejects a fill with no value", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "element",
          steps: [{ action: "fill", selector: "#a" }],
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects a waitFor with neither selector nor value", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "feature",
          steps: [{ action: "waitFor" }],
        },
        "test",
      ),
    ).toThrow(/selector or a value/);
  });

  it("rejects non-numeric timing and scroll values", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "feature",
          steps: [{ action: "waitFor", value: "later" }],
        },
        "test",
      ),
    ).toThrow(/non-negative millisecond/);
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "feature",
          steps: [{ action: "scroll", value: "down" }],
        },
        "test",
      ),
    ).toThrow(/finite pixel/);
  });

  it("rejects an empty step list", () => {
    expect(() =>
      parseWalkthroughDef(
        { slug: "x", granularity: "feature", steps: [] },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "Not A Slug",
          granularity: "feature",
          steps: [{ action: "goto", value: "/" }],
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects an unknown granularity", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "page",
          steps: [{ action: "goto", value: "/" }],
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects an unknown top-level field (strict object)", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "feature",
          steps: [{ action: "goto", value: "/" }],
          bogus: true,
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects goto targets with non-http(s) schemes", () => {
    for (const value of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "chrome://settings",
    ]) {
      expect(() =>
        parseWalkthroughDef(
          {
            slug: "x",
            granularity: "feature",
            steps: [{ action: "goto", value }],
          },
          "test",
        ),
      ).toThrow(EvidenceValidationError);
    }
  });

  it("accepts http(s) and relative goto targets", () => {
    for (const value of [
      "https://example.com/page",
      "http://127.0.0.1:8080/",
      "/settings",
      "settings?tab=1",
    ]) {
      const def = parseWalkthroughDef(
        {
          slug: "ok",
          granularity: "feature",
          steps: [{ action: "goto", value }],
        },
        "test",
      );
      expect(def.steps).toHaveLength(1);
    }
  });

  it("rejects a non-http(s) baseUrl", () => {
    expect(() =>
      parseWalkthroughDef(
        {
          slug: "x",
          granularity: "feature",
          baseUrl: "file:///srv/app/",
          steps: [{ action: "goto", value: "/" }],
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects waitFor and scroll steps carrying both selector and value", () => {
    for (const step of [
      { action: "waitFor", selector: "#a", value: "500" },
      { action: "scroll", selector: "#a", value: "300" },
    ]) {
      expect(() =>
        parseWalkthroughDef(
          { slug: "x", granularity: "feature", steps: [step] },
          "test",
        ),
      ).toThrow(EvidenceValidationError);
    }
  });
});

describe("shipped walkthrough definitions", () => {
  const files = readdirSync(WALKTHROUGHS_DIR).filter((name) =>
    name.endsWith(".json"),
  );

  it("ships at least three definitions", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s validates against the schema", (name) => {
    const parsed = JSON.parse(
      readFileSync(join(WALKTHROUGHS_DIR, name), "utf8"),
    );
    const def = parseWalkthroughDef(parsed, name);
    expect(def.slug).toBeTruthy();
    expect(def.steps.length).toBeGreaterThan(0);
  });

  it("covers all three granularities across the shipped set", () => {
    const granularities = new Set(
      files.map((name) => {
        const parsed = JSON.parse(
          readFileSync(join(WALKTHROUGHS_DIR, name), "utf8"),
        );
        return parseWalkthroughDef(parsed, name).granularity;
      }),
    );
    expect(granularities).toEqual(
      new Set(["element", "feature", "walkthrough"]),
    );
  });
});
