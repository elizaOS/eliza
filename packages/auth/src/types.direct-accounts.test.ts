/** Pins canonical direct-account identifiers and environment aliases for account authority consumers. */

import { describe, expect, it } from "vitest";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  isDirectAccountProvider,
} from "./types.ts";

describe("OpenRouter and xAI direct account identities", () => {
  it.each([
    ["openrouter-api", "OPENROUTER_API_KEY"],
    ["xai-api", "XAI_API_KEY"],
  ] as const)("maps %s to only its canonical env alias", (providerId, env) => {
    expect(DIRECT_ACCOUNT_PROVIDER_IDS).toContain(providerId);
    expect(isDirectAccountProvider(providerId)).toBe(true);
    expect(DIRECT_ACCOUNT_PROVIDER_ENV[providerId]).toBe(env);
  });

  it("does not conflate xAI API billing with Grok subscription identity", () => {
    expect(isDirectAccountProvider("grok")).toBe(false);
    expect(isDirectAccountProvider("grok-subscription")).toBe(false);
  });
});
