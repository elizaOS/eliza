import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
} from "./routing-policy.ts";

describe("isRoutingPolicy", () => {
  it("accepts every documented policy", () => {
    for (const policy of ROUTING_POLICIES) {
      expect(isRoutingPolicy(policy)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isRoutingPolicy("random")).toBe(false);
    expect(isRoutingPolicy("")).toBe(false);
    expect(isRoutingPolicy(42)).toBe(false);
    expect(isRoutingPolicy(null)).toBe(false);
    expect(isRoutingPolicy(undefined)).toBe(false);
  });
});

describe("routing policy constants", () => {
  it("defaults to prefer-local", () => {
    expect(DEFAULT_ROUTING_POLICY).toBe("prefer-local");
  });

  it("covers all dispatch modes", () => {
    expect(ROUTING_POLICIES).toContain("manual");
    expect(ROUTING_POLICIES).toContain("auto");
    expect(ROUTING_POLICIES).toContain("local-only");
    expect(ROUTING_POLICIES).toContain("cloud-only");
    expect(ROUTING_POLICIES).toContain("cheapest");
    expect(ROUTING_POLICIES).toContain("fastest");
    expect(ROUTING_POLICIES).toContain("prefer-local");
    expect(ROUTING_POLICIES).toContain("round-robin");
  });
});
