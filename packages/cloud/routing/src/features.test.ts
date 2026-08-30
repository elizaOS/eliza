/**
 * Unit tests for cloud routing features registry, lookups, and type guards.
 */

import { describe, expect, it } from "vitest";
import { getFeature, isFeature, isFeaturePolicy } from "./features.js";

describe("routing features", () => {
  it("retrieves feature definition by id", () => {
    const llm = getFeature("llm");
    expect(llm).not.toBeNull();

    expect(getFeature("unknown_feature_xyz")).toBeNull();
  });

  it("validates feature and feature policy type guards", () => {
    expect(isFeature("llm")).toBe(true);
    expect(isFeature("tts")).toBe(true);
    expect(isFeature("invalid_feature")).toBe(false);
    expect(isFeature(123)).toBe(false);
    expect(isFeature(null)).toBe(false);

    expect(isFeaturePolicy("local")).toBe(true);
    expect(isFeaturePolicy("cloud")).toBe(true);
    expect(isFeaturePolicy("auto")).toBe(true);
    expect(isFeaturePolicy("manual")).toBe(false);
    expect(isFeaturePolicy(undefined)).toBe(false);
  });
});
