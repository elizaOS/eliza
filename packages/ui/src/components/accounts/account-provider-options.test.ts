/**
 * Tests the consolidated Add Account provider-option metadata that drives the
 * provider picker grouping and eligibility copy.
 */

import { CODING_PROVIDER_DESCRIPTORS } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PROVIDER_OPTIONS } from "./account-provider-options";

describe("consolidated account provider picker", () => {
  it("covers the canonical provider descriptor catalog exactly once", () => {
    const optionIds = ACCOUNT_PROVIDER_OPTIONS.map((option) => option.id);
    expect([...optionIds].sort()).toEqual(
      Object.keys(CODING_PROVIDER_DESCRIPTORS).sort(),
    );
    expect(new Set(optionIds).size).toBe(optionIds.length);
  });

  it("keeps chat API providers separate from coding subscription providers", () => {
    const chat = ACCOUNT_PROVIDER_OPTIONS.filter(
      (option) => option.category === "chat",
    ).map((option) => option.id);
    const coding = ACCOUNT_PROVIDER_OPTIONS.filter(
      (option) => option.category === "coding",
    ).map((option) => option.id);

    expect(chat).toContain("anthropic-api");
    expect(chat).toContain("openai-api");
    expect(coding).toContain("anthropic-subscription");
    expect(coding).toContain("openai-codex");
  });

  it("labels Claude subscription for its first-party coding surface", () => {
    const claudeSubscription = ACCOUNT_PROVIDER_OPTIONS.find(
      (option) => option.id === "anthropic-subscription",
    );

    expect(claudeSubscription?.eligibility).toContain("code-agent");
    expect(claudeSubscription?.eligibility).not.toContain("chat");
  });

  it("lists subscriptions before API keys", () => {
    const firstApiIndex = ACCOUNT_PROVIDER_OPTIONS.findIndex(
      (option) => option.category === "chat",
    );
    const lastCodingIndex = ACCOUNT_PROVIDER_OPTIONS.map(
      (option) => option.category,
    ).lastIndexOf("coding");
    expect(lastCodingIndex).toBeLessThan(firstApiIndex);
  });
});
