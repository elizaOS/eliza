/**
 * Unit tests for cloud routing features registry, lookups, and type guards.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURE_POLICY,
  FEATURE_IDS,
  FEATURE_POLICIES,
  FEATURES,
  getFeature,
  isFeature,
  isFeaturePolicy,
} from "./features.js";

describe("routing features", () => {
  it("exports valid feature registry and default policies", () => {
    expect(DEFAULT_FEATURE_POLICY).toBe("auto");
    expect(FEATURE_POLICIES).toEqual(["local", "cloud", "auto"]);
    expect(FEATURES.length).toBeGreaterThan(0);
    expect(FEATURE_IDS).toContain("llm");
    expect(FEATURE_IDS).toContain("embeddings");
    expect(FEATURE_IDS).toContain("tool_use");
  });

  it("retrieves feature definition by id", () => {
    const llm = getFeature("llm");
    expect(llm).not.toBeNull();
    expect(llm?.id).toBe("llm");
    expect(llm?.settingKey).toBe("ELIZAOS_CLOUD_ROUTING_LLM");
    expect(llm?.description).toBeDefined();

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
