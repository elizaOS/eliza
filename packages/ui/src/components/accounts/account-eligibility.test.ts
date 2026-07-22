/**
 * Tests the data-driven eligibility resolver: prefer server runtimeEligibility,
 * fall back conservatively to static inference, and collapse health into ONE
 * connection signal.
 */

import { describe, expect, it } from "vitest";
import {
  eligibilityChips,
  providerConnectionState,
  resolveProviderEligibility,
} from "./account-eligibility";
import { getAccountProviderOption } from "./account-provider-options";

function option(id: Parameters<typeof getAccountProviderOption>[0]) {
  const found = getAccountProviderOption(id);
  if (!found) throw new Error(`missing provider option: ${id}`);
  return found;
}

const anthropicApi = option("anthropic-api");
const claudeSub = option("anthropic-subscription");
const deepseekCoding = option("deepseek-coding");

describe("resolveProviderEligibility", () => {
  it("prefers server runtime eligibility over static inference", () => {
    const resolved = resolveProviderEligibility(claudeSub, {
      chat: true,
      codingAgent: true,
      note: "subscription chat enabled",
    });
    expect(resolved.source).toBe("runtime");
    expect(resolved.chat).toBe(true);
    expect(resolved.codingAgent).toBe(true);
    expect(resolved.note).toBe("subscription chat enabled");
  });

  it("conservatively infers chat+coding for BYOK API providers", () => {
    const resolved = resolveProviderEligibility(anthropicApi, undefined);
    expect(resolved.source).toBe("inferred");
    expect(resolved.chat).toBe(true);
    expect(resolved.codingAgent).toBe(true);
  });

  it("conservatively infers coding-only for subscription providers", () => {
    const resolved = resolveProviderEligibility(claudeSub, undefined);
    expect(resolved.source).toBe("inferred");
    expect(resolved.chat).toBe(false);
    expect(resolved.codingAgent).toBe(true);
  });

  it("infers neither for explicitly unavailable providers", () => {
    const resolved = resolveProviderEligibility(deepseekCoding, undefined);
    expect(resolved.chat).toBe(false);
    expect(resolved.codingAgent).toBe(false);
  });
});

describe("eligibilityChips", () => {
  it("emits at most two capability chips, no auth-method noise", () => {
    const chips = eligibilityChips({
      chat: true,
      codingAgent: true,
      source: "runtime",
    });
    expect(chips.map((c) => c.key)).toEqual(["chat", "coding"]);
  });

  it("shows a single not-eligible chip when nothing is available", () => {
    const chips = eligibilityChips({
      chat: false,
      codingAgent: false,
      source: "inferred",
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.key).toBe("none");
  });
});

describe("providerConnectionState (one signal per row)", () => {
  it("is disconnected with no accounts", () => {
    expect(providerConnectionState([])).toBe("disconnected");
  });

  it("is healthy when every account is ok", () => {
    expect(
      providerConnectionState([
        { enabled: true, health: "ok" },
        { enabled: true, health: "ok" },
      ]),
    ).toBe("connected-healthy");
  });

  it("flags attention when any account needs reauth, is invalid, or expired", () => {
    expect(
      providerConnectionState([
        { enabled: true, health: "ok" },
        { enabled: true, health: "needs-reauth" },
      ]),
    ).toBe("connected-attention");
    expect(
      providerConnectionState([
        { enabled: true, health: "ok" },
        { enabled: true, health: "expired" },
      ]),
    ).toBe("connected-attention");
  });
});
