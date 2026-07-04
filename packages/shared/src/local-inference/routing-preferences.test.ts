/**
 * Covers the local/cloud routing-policy union: that ROUTING_POLICIES exposes
 * local-only, cloud-only, and auto with no duplicates, that
 * DEFAULT_ROUTING_POLICY is a member, and that the isRoutingPolicy type guard
 * accepts every member and rejects non-members. Pure Vitest over the exported
 * constants.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
  type RoutingPolicy,
} from "./routing-preferences.js";

describe("routing policy union", () => {
  it("exposes local-only and cloud-only as first-class policies", () => {
    expect(ROUTING_POLICIES).toContain("local-only");
    expect(ROUTING_POLICIES).toContain("cloud-only");
    expect(ROUTING_POLICIES).toContain("auto");
  });

  it("has no duplicate entries", () => {
    expect(new Set(ROUTING_POLICIES).size).toBe(ROUTING_POLICIES.length);
  });

  it("default policy is a member of the list", () => {
    expect(ROUTING_POLICIES).toContain(DEFAULT_ROUTING_POLICY);
  });

  it("isRoutingPolicy accepts every member and rejects others", () => {
    for (const policy of ROUTING_POLICIES) {
      expect(isRoutingPolicy(policy)).toBe(true);
    }
    expect(isRoutingPolicy("local-only" satisfies RoutingPolicy)).toBe(true);
    expect(isRoutingPolicy("nonsense")).toBe(false);
    expect(isRoutingPolicy(undefined)).toBe(false);
    expect(isRoutingPolicy(42)).toBe(false);
  });
});
