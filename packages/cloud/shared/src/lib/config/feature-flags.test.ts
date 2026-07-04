// Exercises feature flags behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getDisabledFeatures,
  getEnabledFeatures,
  isFeatureEnabled,
  isRouteEnabled,
} from "./feature-flags";

const ENV_KEYS = ["FEATURE_FLAGS_DISABLED", "FEATURE_FLAGS_ENABLED"];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("isFeatureEnabled env override", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("returns the compiled default when no env override is set", () => {
    expect(isFeatureEnabled("billing")).toBe(true);
  });

  test("FEATURE_FLAGS_DISABLED force-disables a flag (kill switch)", () => {
    process.env.FEATURE_FLAGS_DISABLED = "billing";
    expect(isFeatureEnabled("billing")).toBe(false);
    expect(isFeatureEnabled("mcp")).toBe(true);
  });

  test("disabled list accepts multiple comma/space separated flags", () => {
    process.env.FEATURE_FLAGS_DISABLED = "billing, mcp ,";
    expect(isFeatureEnabled("billing")).toBe(false);
    expect(isFeatureEnabled("mcp")).toBe(false);
    expect(isFeatureEnabled("gallery")).toBe(true);
  });

  test("FEATURE_FLAGS_ENABLED force-enables a flag", () => {
    process.env.FEATURE_FLAGS_ENABLED = "gallery";
    expect(isFeatureEnabled("gallery")).toBe(true);
  });

  test("disable wins over enable when a flag is in both lists", () => {
    process.env.FEATURE_FLAGS_DISABLED = "billing";
    process.env.FEATURE_FLAGS_ENABLED = "billing";
    expect(isFeatureEnabled("billing")).toBe(false);
  });

  test("getEnabledFeatures and getDisabledFeatures honor the override", () => {
    process.env.FEATURE_FLAGS_DISABLED = "billing";
    expect(getEnabledFeatures()).not.toContain("billing");
    expect(getDisabledFeatures()).toContain("billing");
  });

  test("isRouteEnabled honors the override for a mapped route", () => {
    expect(isRouteEnabled("/api/billing/checkout")).toBe(true);
    process.env.FEATURE_FLAGS_DISABLED = "billing";
    expect(isRouteEnabled("/api/billing/checkout")).toBe(false);
    expect(isRouteEnabled("/api/v1/gallery")).toBe(true);
  });
});
