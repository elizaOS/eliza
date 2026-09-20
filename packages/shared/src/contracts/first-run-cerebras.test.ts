/** Exercises real provider aliases, onboarding signals and stored account translations. */
import { describe, expect, it } from "vitest";
import {
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  getStoredSubscriptionProviderForRequest,
  normalizeFirstRunProviderId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
} from "./first-run-options";
import { isLinkedAccountProviderId } from "./service-routing";

describe("Cerebras first-run provider", () => {
  it("normalizes its id, casing, and the linked-account alias", () => {
    expect(normalizeFirstRunProviderId("cerebras")).toBe("cerebras");
    expect(normalizeFirstRunProviderId("CEREBRAS")).toBe("cerebras");
    expect(normalizeFirstRunProviderId("cerebras-api")).toBe("cerebras");
    expect(getFirstRunProviderOption("cerebras")?.id).toBe("cerebras");
  });

  it("signals onboarding via CEREBRAS_API_KEY only", () => {
    expect(getFirstRunProviderSignalEnvKeys("cerebras")).toEqual([
      "CEREBRAS_API_KEY",
    ]);
  });

  it("maps to the cerebras-api direct account so it surfaces in the switcher", () => {
    expect(getDirectAccountProviderForFirstRunProvider("cerebras")).toBe(
      "cerebras-api",
    );
    expect(isLinkedAccountProviderId("cerebras-api")).toBe(true);
  });
});

describe("first-run provider normalization", () => {
  it("normalizes legacy local-provider aliases identically", () => {
    expect(normalizeFirstRunProviderId("llama_local")).toBe("ollama");
    expect(normalizeFirstRunProviderId("llama-local")).toBe("ollama");
  });

  it("subscription request storage ids are driven by the selection registry", () => {
    for (const provider of SUBSCRIPTION_PROVIDER_SELECTIONS) {
      expect(getStoredSubscriptionProviderForRequest(provider.id)).toBe(
        provider.storedProvider,
      );
      expect(
        getStoredSubscriptionProviderForRequest(provider.id.toUpperCase()),
      ).toBe(provider.storedProvider);
      expect(
        getStoredSubscriptionProviderForRequest(provider.storedProvider),
      ).toBe(provider.storedProvider);
    }
    expect(getStoredSubscriptionProviderForRequest("openai")).toBeNull();
    expect(getStoredSubscriptionProviderForRequest(null)).toBeNull();
  });
});
