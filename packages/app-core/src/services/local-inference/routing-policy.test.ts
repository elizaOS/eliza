/**
 * Policy resolver tests — real HandlerRegistration objects, real
 * policyEngine instance. Exercises every policy's picking logic plus
 * the latency-sample ring buffer used by "fastest".
 */

import { describe, expect, it } from "vitest";
import type { HandlerRegistration } from "./handler-registry";
import { policyEngine } from "./routing-policy";

function reg(
  provider: string,
  priority: number,
  modelType = "TEXT_LARGE",
): HandlerRegistration {
  return {
    modelType,
    provider,
    priority,
    registeredAt: new Date().toISOString(),
    handler: async () => "stub",
  };
}

describe("policyEngine.pickProvider", () => {
  it("manual + preferred match → picks preferred", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "manual",
      preferredProvider: "anthropic",
      candidates: [reg("openai", 5), reg("anthropic", 3)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("anthropic");
  });

  it("manual + no preferred → picks highest priority", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "manual",
      preferredProvider: null,
      candidates: [reg("low", 1), reg("high", 100)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("high");
  });

  it("manual + preferred that isn't registered → falls back to highest priority", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "manual",
      preferredProvider: "nonexistent",
      candidates: [reg("openai", 5), reg("anthropic", 3)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("openai");
  });

  it("cheapest picks the lowest-cost provider", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "cheapest",
      preferredProvider: null,
      candidates: [
        reg("anthropic", 10),
        reg("milady-local-inference", 0),
        reg("openai", 5),
      ],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("milady-local-inference");
  });

  it("cheapest prefers subscription access over API keys and Eliza Cloud", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "cheapest",
      preferredProvider: null,
      candidates: [
        reg("elizacloud", 100),
        reg("anthropic", 90),
        reg("openai-codex", 20),
      ],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("openai-codex");
  });

  it("prefer-local → picks local when present", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "prefer-local",
      preferredProvider: null,
      candidates: [reg("anthropic", 10), reg("milady-local-inference", 0)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("milady-local-inference");
  });

  it("prefer-local → falls back to device-bridge when local absent", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "prefer-local",
      preferredProvider: null,
      candidates: [reg("anthropic", 10), reg("milady-device-bridge", 0)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("milady-device-bridge");
  });

  it("prefer-local → falls back to highest native priority when no local or bridge", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "prefer-local",
      preferredProvider: null,
      candidates: [reg("anthropic", 10), reg("openai", 5)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("anthropic");
  });

  it("fastest with no samples → falls back to native priority", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEST_MODEL_NEW",
      policy: "fastest",
      preferredProvider: null,
      candidates: [
        reg("a", 1, "TEST_MODEL_NEW"),
        reg("b", 10, "TEST_MODEL_NEW"),
      ],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("b");
  });

  it("fastest picks the provider with lowest tracked p50", () => {
    policyEngine.recordLatency("slow-one", "TEST_MT", 1000);
    policyEngine.recordLatency("slow-one", "TEST_MT", 1200);
    policyEngine.recordLatency("fast-one", "TEST_MT", 50);
    policyEngine.recordLatency("fast-one", "TEST_MT", 75);
    const pick = policyEngine.pickProvider({
      modelType: "TEST_MT",
      policy: "fastest",
      preferredProvider: null,
      candidates: [
        reg("slow-one", 10, "TEST_MT"),
        reg("fast-one", 1, "TEST_MT"),
      ],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("fast-one");
  });

  it("round-robin picks the least-recently-picked provider", () => {
    policyEngine.recordPick("recent", "TEST_RR");
    // Ensure "stale" has an older timestamp — real-world races are
    // negligible but let's make the test deterministic.
    const pick = policyEngine.pickProvider({
      modelType: "TEST_RR",
      policy: "round-robin",
      preferredProvider: null,
      candidates: [reg("recent", 10, "TEST_RR"), reg("stale", 1, "TEST_RR")],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("stale");
  });

  it("always excludes the self provider (the router itself)", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "manual",
      preferredProvider: "milady-router",
      candidates: [reg("milady-router", 9999), reg("openai", 0)],
      selfProvider: "milady-router",
    });
    expect(pick?.provider).toBe("openai");
  });

  it("returns null when no candidates are available", () => {
    const pick = policyEngine.pickProvider({
      modelType: "TEXT_LARGE",
      policy: "manual",
      preferredProvider: null,
      candidates: [],
      selfProvider: "milady-router",
    });
    expect(pick).toBeNull();
  });
});
