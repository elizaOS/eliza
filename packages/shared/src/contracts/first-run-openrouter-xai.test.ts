/** Verifies setup aliases resolve to the same OpenRouter and xAI account authority IDs. */

import { describe, expect, it } from "vitest";
import {
  DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
  getDirectAccountProviderForFirstRunProvider,
  normalizeFirstRunProviderId,
} from "./first-run-options.ts";

describe("OpenRouter and xAI setup account authority", () => {
  it.each([
    ["openrouter", "openrouter-api"],
    ["xai", "xai-api"],
  ] as const)("maps %s to %s", (provider, accountProvider) => {
    expect(DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER[provider]).toBe(
      accountProvider,
    );
    expect(getDirectAccountProviderForFirstRunProvider(provider)).toBe(
      accountProvider,
    );
    expect(normalizeFirstRunProviderId(accountProvider)).toBe(provider);
  });
});
