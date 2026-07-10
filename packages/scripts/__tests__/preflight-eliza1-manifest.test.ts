/**
 * Verifies that the nightly manifest preflight follows the published Gemma
 * bundle layout and rejects malformed runtime file buckets without networking.
 */

import { describe, expect, it } from "vitest";
import { ELIZA_1_PUBLISHED_TIER_SLUGS } from "../../shared/src/local-inference/catalog.js";
import {
  manifestUrl,
  PUBLISHED_TIER_SLUG,
  validateShape,
} from "../benchmark/preflight-eliza1-manifest.mjs";

describe("Eliza-1 published manifest preflight", () => {
  it("maps stable runtime ids to architecture-oriented bundle paths", () => {
    expect(PUBLISHED_TIER_SLUG).toEqual({
      "eliza-1-2b": "e2b",
      "eliza-1-4b": "e4b",
      "eliza-1-9b": "12b",
      "eliza-1-27b": "31b",
      "eliza-1-27b-256k": "31b-256k",
    });
    expect(PUBLISHED_TIER_SLUG).toEqual(ELIZA_1_PUBLISHED_TIER_SLUGS);
    expect(manifestUrl("eliza-1-2b")).toContain(
      "/bundles/e2b/eliza-1.manifest.json",
    );
  });

  it("accepts the runtime manifest array contract", () => {
    const manifest = {
      files: {
        text: [{}],
        voice: [{}],
        cache: [{}],
        asr: [],
        vision: [],
        mtp: [],
      },
    };
    expect(validateShape(manifest)).toEqual([]);
  });

  it("rejects missing, empty, and non-array buckets", () => {
    const problems = validateShape({
      files: {
        text: [],
        voice: {},
        cache: [{}],
        asr: [],
        vision: [],
      },
    });
    expect(problems).toContain(
      "files.text: required non-empty array, received empty array",
    );
    expect(problems).toContain("files.voice: expected array, received object");
    expect(problems).toContain("files.mtp: expected array, received undefined");
  });
});
