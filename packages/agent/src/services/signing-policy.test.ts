/**
 * Unit coverage for SigningPolicyEvaluator — replay protection, chain/contract
 * allow/denylists, value cap, method selectors, rate limits, and human
 * confirmation thresholds. Zero tests existed for this 232-line policy engine.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultPolicy,
  SigningPolicyEvaluator,
  type SigningRequest,
} from "./signing-policy.ts";

function makeRequest(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    requestId: "req-1",
    chainId: 1,
    to: "0xabc",
    value: "1000000000000000", // 0.001 ETH
    data: "0x",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SigningPolicyEvaluator", () => {
  it("allows a valid request under the default policy", () => {
    const ev = new SigningPolicyEvaluator();
    const d = ev.evaluate(makeRequest());
    expect(d.allowed).toBe(true);
    expect(d.matchedRule).toBe("allowed");
  });

  it("rejects a replayed request id", () => {
    const ev = new SigningPolicyEvaluator();
    const req = makeRequest({ requestId: "dup" });
    expect(ev.evaluate(req).allowed).toBe(true);
    ev.recordRequest("dup");
    const d = ev.evaluate(req);
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("replay_protection");
  });

  it("rejects a chain not in the allowlist", () => {
    const policy = createDefaultPolicy();
    policy.allowedChainIds = [1, 137];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ chainId: 8453 }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("chain_id_allowlist");
  });

  it("accepts a chain in the allowlist", () => {
    const policy = createDefaultPolicy();
    policy.allowedChainIds = [1, 137];
    const ev = new SigningPolicyEvaluator(policy);
    expect(ev.evaluate(makeRequest({ chainId: 137 })).allowed).toBe(true);
  });

  it("rejects a denylisted contract (case-insensitive)", () => {
    const policy = createDefaultPolicy();
    policy.deniedContracts = ["0xABC"];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ to: "0xabc" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("contract_denylist");
  });

  it("rejects a contract not in the allowlist", () => {
    const policy = createDefaultPolicy();
    policy.allowedContracts = ["0xdef"];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ to: "0xabc" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("contract_allowlist");
  });

  it("accepts a contract in the allowlist (case-insensitive)", () => {
    const policy = createDefaultPolicy();
    policy.allowedContracts = ["0xDEF"];
    const ev = new SigningPolicyEvaluator(policy);
    expect(ev.evaluate(makeRequest({ to: "0xdef" })).allowed).toBe(true);
  });

  it("rejects a value above the cap", () => {
    const policy = createDefaultPolicy();
    policy.maxTransactionValueWei = "1000000000000000";
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ value: "1000000000000001" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("value_cap");
  });

  it("rejects an unparseable value", () => {
    const ev = new SigningPolicyEvaluator();
    const d = ev.evaluate(makeRequest({ value: "not-a-number" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("value_parse_error");
  });

  it("rejects a negative value before signing", () => {
    const ev = new SigningPolicyEvaluator();
    const d = ev.evaluate(makeRequest({ value: "-1" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("value_parse_error");
  });

  it("rejects a method selector not in the allowlist", () => {
    const policy = createDefaultPolicy();
    policy.allowedMethodSelectors = ["0x12345678"];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(
      makeRequest({
        data: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
      }),
    );
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("method_selector_allowlist");
  });

  it("accepts an allowed method selector (case-insensitive)", () => {
    const policy = createDefaultPolicy();
    policy.allowedMethodSelectors = ["0x12345678"];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(
      makeRequest({
        data: "0x12345678deadbeef0000000000000000000000000000000000000000000000",
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it("rejects partial calldata that cannot contain an allowed selector", () => {
    const policy = createDefaultPolicy();
    policy.allowedMethodSelectors = ["0x12345678"];
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ data: "0x1234" }));
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("method_selector_allowlist");
  });

  it("allows empty calldata for a native transfer", () => {
    const policy = createDefaultPolicy();
    policy.allowedMethodSelectors = ["0x12345678"];
    const ev = new SigningPolicyEvaluator(policy);
    expect(ev.evaluate(makeRequest({ data: "0x" })).allowed).toBe(true);
  });

  it("enforces the hourly rate limit", () => {
    const policy = createDefaultPolicy();
    policy.maxTransactionsPerHour = 2;
    policy.maxTransactionsPerDay = 100;
    const ev = new SigningPolicyEvaluator(policy);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
      ev.recordRequest("a");
      ev.recordRequest("b");
      const d = ev.evaluate(makeRequest({ requestId: "c" }));
      expect(d.allowed).toBe(false);
      expect(d.matchedRule).toBe("rate_limit_hourly");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the daily rate limit", () => {
    const policy = createDefaultPolicy();
    policy.maxTransactionsPerHour = 100;
    policy.maxTransactionsPerDay = 2;
    const ev = new SigningPolicyEvaluator(policy);
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-20T12:00:00Z").getTime();
      vi.setSystemTime(now - 3 * 3600 * 1000);
      ev.recordRequest("a");
      vi.setSystemTime(now - 2 * 3600 * 1000);
      ev.recordRequest("b");
      vi.setSystemTime(now);
      const d = ev.evaluate(makeRequest({ requestId: "c" }));
      expect(d.allowed).toBe(false);
      expect(d.matchedRule).toBe("rate_limit_daily");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires human confirmation above the threshold", () => {
    const policy = createDefaultPolicy();
    policy.humanConfirmationThresholdWei = "1000000000000000";
    policy.requireHumanConfirmation = false;
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ value: "2000000000000000" }));
    expect(d.allowed).toBe(true);
    expect(d.requiresHumanConfirmation).toBe(true);
  });

  it("does not require confirmation below the threshold", () => {
    const policy = createDefaultPolicy();
    policy.humanConfirmationThresholdWei = "1000000000000000";
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest({ value: "500000000000000" }));
    expect(d.allowed).toBe(true);
    expect(d.requiresHumanConfirmation).toBe(false);
  });

  it("requires confirmation when policy demands it unconditionally", () => {
    const policy = createDefaultPolicy();
    policy.requireHumanConfirmation = true;
    const ev = new SigningPolicyEvaluator(policy);
    const d = ev.evaluate(makeRequest());
    expect(d.requiresHumanConfirmation).toBe(true);
  });

  it("prunes expired entries from the request log", () => {
    const policy = createDefaultPolicy();
    policy.maxTransactionsPerDay = 1;
    const ev = new SigningPolicyEvaluator(policy);
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-20T12:00:00Z").getTime();
      vi.setSystemTime(now - 48 * 3600 * 1000);
      ev.recordRequest("old");
      vi.setSystemTime(now);
      expect(ev.evaluate(makeRequest({ requestId: "new" })).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
