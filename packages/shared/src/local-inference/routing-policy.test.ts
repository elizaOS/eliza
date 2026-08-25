/**
 * Unit coverage for routing policy definitions and predicates in routing-policy.ts.
 *
 * Tests policy list contents, isRoutingPolicy type guard against valid/invalid values,
 * and DEFAULT_ROUTING_POLICY assignment.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
} from "./routing-policy.js";

describe("routing-policy", () => {
  it("exports all expected routing policies in ROUTING_POLICIES", () => {
    expect(Array.isArray(ROUTING_POLICIES)).toBe(true);
    expect(ROUTING_POLICIES).toEqual([
      "manual",
      "auto",
      "local-only",
      "cloud-only",
      "cheapest",
      "fastest",
      "prefer-local",
      "round-robin",
    ]);
  });

  it("validates valid routing policies via isRoutingPolicy", () => {
    for (const policy of ROUTING_POLICIES) {
      expect(isRoutingPolicy(policy)).toBe(true);
    }
  });

  it("rejects invalid values in isRoutingPolicy", () => {
    expect(isRoutingPolicy("invalid-policy")).toBe(false);
    expect(isRoutingPolicy("")).toBe(false);
    expect(isRoutingPolicy("PREFER-LOCAL")).toBe(false);
    expect(isRoutingPolicy(123)).toBe(false);
    expect(isRoutingPolicy(null)).toBe(false);
    expect(isRoutingPolicy(undefined)).toBe(false);
    expect(isRoutingPolicy({})).toBe(false);
    expect(isRoutingPolicy([])).toBe(false);
  });

  it("sets DEFAULT_ROUTING_POLICY to 'prefer-local'", () => {
    expect(DEFAULT_ROUTING_POLICY).toBe("prefer-local");
    expect(isRoutingPolicy(DEFAULT_ROUTING_POLICY)).toBe(true);
  });
});
