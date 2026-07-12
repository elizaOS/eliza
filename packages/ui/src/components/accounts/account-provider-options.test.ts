/**
 * Tests the consolidated Add Account provider-option metadata that drives the
 * provider picker grouping and eligibility copy.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_PROVIDER_OPTIONS } from "./AddAccountDialog";

describe("consolidated account provider picker", () => {
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

  it("labels Claude subscription as coding-agent only instead of default chat", () => {
    const claudeSubscription = ACCOUNT_PROVIDER_OPTIONS.find(
      (option) => option.id === "anthropic-subscription",
    );

    expect(claudeSubscription?.eligibility).toContain("code-agent");
    expect(claudeSubscription?.eligibility).toContain("not chat");
  });
});
