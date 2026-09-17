/**
 * Exercises the in-memory subscription-auth registry: register/lookup by id,
 * listing and last-registration-wins override (plugin over built-in).
 * Deterministic — no model or DB, the
 * registry Map is the whole system under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getSubscriptionAuthProvider,
  hasSubscriptionAuthProvider,
  listSubscriptionAuthProviders,
  registerSubscriptionAuthProvider,
  resetSubscriptionAuthProviders,
} from "./registry.ts";
import type { SubscriptionAuthProvider } from "./types.ts";

const codexLike: SubscriptionAuthProvider = {
  id: "openai-codex",
};

describe("subscription-auth registry", () => {
  afterEach(() => {
    resetSubscriptionAuthProviders();
  });

  it("registers and looks up a descriptor by id", () => {
    expect(hasSubscriptionAuthProvider("openai-codex")).toBe(false);
    registerSubscriptionAuthProvider(codexLike);
    expect(hasSubscriptionAuthProvider("openai-codex")).toBe(true);
    expect(getSubscriptionAuthProvider("openai-codex")).toBe(codexLike);
    expect(getSubscriptionAuthProvider("nope")).toBeUndefined();
  });

  it("lists every registered descriptor", () => {
    registerSubscriptionAuthProvider(codexLike);
    registerSubscriptionAuthProvider({ id: "gemini-cli" });
    expect(
      listSubscriptionAuthProviders()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["gemini-cli", "openai-codex"]);
  });

  it("overwrites a prior registration for the same id (plugin overrides built-in)", () => {
    const builtin: SubscriptionAuthProvider = {
      id: "openai-codex",
    };
    registerSubscriptionAuthProvider(builtin);
    registerSubscriptionAuthProvider(codexLike);
    expect(getSubscriptionAuthProvider("openai-codex")).toBe(codexLike);
    expect(listSubscriptionAuthProviders()).toHaveLength(1);
  });
});
