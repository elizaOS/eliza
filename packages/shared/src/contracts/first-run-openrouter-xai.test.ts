/** Verifies setup aliases resolve to the same OpenRouter and xAI account authority IDs. */

import { describe, expect, it } from "vitest";
import {
  getFirstRunProviderOption as coreGetFirstRunProviderOption,
  normalizeFirstRunProviderId as coreNormalizeFirstRunProviderId,
} from "../../../core/src/contracts/first-run-options.ts";
import {
  DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderFamily,
  getFirstRunProviderOption,
  normalizeFirstRunProviderId,
} from "./first-run-options.ts";

describe("OpenRouter and xAI setup account authority", () => {
  it("maps OpenRouter to its linked-account authority", () => {
    expect(DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER.openrouter).toBe(
      "openrouter-api",
    );
    expect(getDirectAccountProviderForFirstRunProvider("openrouter")).toBe(
      "openrouter-api",
    );
    expect(normalizeFirstRunProviderId("openrouter-api")).toBe("openrouter");
  });

  it("normalizes xAI aliases idempotently to the catalog-backed Grok option", () => {
    for (const alias of ["xai", "xai-api", "grok"] as const) {
      const normalized = normalizeFirstRunProviderId(alias);
      expect(normalized).toBe("grok");
      expect(normalizeFirstRunProviderId(normalized)).toBe(normalized);
      expect(coreNormalizeFirstRunProviderId(alias)).toBe(normalized);
      expect(coreNormalizeFirstRunProviderId(normalized)).toBe(normalized);
      expect(getFirstRunProviderOption(alias)).toMatchObject({
        id: "grok",
        family: "grok",
      });
      expect(coreGetFirstRunProviderOption(alias)).toMatchObject({
        id: "grok",
        family: "grok",
      });
      expect(getFirstRunProviderFamily(alias)).toBe("grok");
      expect(getDirectAccountProviderForFirstRunProvider(alias)).toBe(
        "xai-api",
      );
    }
  });
});
