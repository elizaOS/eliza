import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltinSubscriptionAuthProviders } from "./builtin-providers.ts";
import {
  getSubscriptionAuthProvider,
  listSubscriptionAuthProviders,
  registerSubscriptionAuthProvider,
  resetSubscriptionAuthProviders,
} from "./registry.ts";

const ids = ["openai-codex", "gemini-cli", "deepseek-coding"];
afterEach(resetSubscriptionAuthProviders);

describe("default subscription providers", () => {
  it.each(ids)("preserves a custom %s registered before defaults", (id) => {
    const custom = { id, detectExternalCredentials: () => null };
    registerSubscriptionAuthProvider(custom);
    ensureBuiltinSubscriptionAuthProviders();
    ensureBuiltinSubscriptionAuthProviders();
    expect(getSubscriptionAuthProvider(id)).toBe(custom);
    expect(
      listSubscriptionAuthProviders()
        .map((provider) => provider.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it("allows a later override and reseeds after reset", () => {
    ensureBuiltinSubscriptionAuthProviders();
    const custom = { id: "gemini-cli", detectExternalCredentials: () => null };
    registerSubscriptionAuthProvider(custom);
    ensureBuiltinSubscriptionAuthProviders();
    expect(getSubscriptionAuthProvider(custom.id)).toBe(custom);
    resetSubscriptionAuthProviders();
    ensureBuiltinSubscriptionAuthProviders();
    expect(listSubscriptionAuthProviders()).toHaveLength(ids.length);
    expect(getSubscriptionAuthProvider(custom.id)).not.toBe(custom);
  });
});
