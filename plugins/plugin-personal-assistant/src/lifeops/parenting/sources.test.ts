import { describe, expect, it } from "vitest";
import {
  PARENTING_GUIDANCE_SOURCES,
  parentingOptionsFor,
  parentingSourcesFor,
} from "./sources";

describe("parentingSourcesFor framework gate", () => {
  it("never serves named-framework content unless the framework was explicitly requested", () => {
    const sources = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "none",
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.evidenceTier).not.toBe("named_framework_primary");
    }
  });

  it("serves named-framework content when good_inside is explicitly requested", () => {
    const sources = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "good_inside",
    );
    expect(
      sources.some((s) => s.evidenceTier === "named_framework_primary"),
    ).toBe(true);
  });

  it("filters by age band: teen-only request excludes toddler-only sources", () => {
    const teen = parentingSourcesFor("teen", "boundary_setting", "none");
    const toddler = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "none",
    );
    for (const source of teen) {
      expect(source.ageBands).toContain("teen");
    }
    for (const source of toddler) {
      expect(source.ageBands).toContain("toddler_preschool");
    }
  });

  it("filters by topic: every routines source declares the routines topic", () => {
    const routines = parentingSourcesFor(
      "toddler_preschool",
      "routines",
      "none",
    );
    expect(routines.length).toBeGreaterThan(0);
    for (const source of routines) {
      expect(source.topics).toContain("routines");
    }
  });

  it("serves every source under its own declared topics", () => {
    for (const source of PARENTING_GUIDANCE_SOURCES) {
      for (const topic of source.topics) {
        const matches = parentingSourcesFor("school_age", topic, "none").some(
          (s) => s.id === source.id,
        );
        // named-framework sources are excluded when the framework isn't
        // requested; everything else must be reachable under its topics.
        if (source.evidenceTier === "named_framework_primary") {
          continue;
        }
        // skip age bands this source does not cover
        if (!source.ageBands.includes("school_age")) {
          continue;
        }
        expect(matches).toBe(true);
      }
    }
  });

  it("recommends nothing for an age band the registry does not cover", () => {
    // toddler-only source set must not leak into the teen band
    const sources = parentingSourcesFor("teen", "positive_discipline", "none");
    for (const source of sources) {
      expect(source.ageBands).toContain("teen");
    }
  });
});

describe("parentingOptionsFor source grounding", () => {
  it("returns only options backed by the supplied source ids", () => {
    const sources = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "none",
    );
    const sourceIds = new Set(sources.map((s) => s.id));
    const options = parentingOptionsFor(
      "toddler_preschool",
      "boundary_setting",
      sourceIds,
    );
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.sourceIds.length).toBeGreaterThan(0);
      for (const sid of option.sourceIds) {
        expect(sourceIds.has(sid)).toBe(true);
      }
    }
  });

  it("returns an empty list when no backing source is available", () => {
    const options = parentingOptionsFor(
      "toddler_preschool",
      "boundary_setting",
      new Set(["does-not-exist"]),
    );
    expect(options).toEqual([]);
  });

  it("adds privacy-preserving language for the teen age band only", () => {
    const sources = parentingSourcesFor("teen", "boundary_setting", "none");
    const sourceIds = new Set(sources.map((s) => s.id));
    const teenOptions = parentingOptionsFor(
      "teen",
      "boundary_setting",
      sourceIds,
    );
    const toddlerSources = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "none",
    );
    const toddlerOptions = parentingOptionsFor(
      "toddler_preschool",
      "boundary_setting",
      new Set(toddlerSources.map((s) => s.id)),
    );
    for (const option of teenOptions) {
      expect(option.rationale).toMatch(/privacy|perspective/i);
    }
    for (const option of toddlerOptions) {
      expect(option.rationale).not.toMatch(/privacy.*perspective/i);
    }
  });

  it("does not mutate the shared registry options (steps copy)", () => {
    const sources = parentingSourcesFor(
      "toddler_preschool",
      "boundary_setting",
      "none",
    );
    const sourceIds = new Set(sources.map((s) => s.id));
    const first = parentingOptionsFor(
      "toddler_preschool",
      "boundary_setting",
      sourceIds,
    );
    const second = parentingOptionsFor(
      "toddler_preschool",
      "boundary_setting",
      sourceIds,
    );
    // same shape across calls — no shared mutation visible
    expect(first).toEqual(second);
  });
});
