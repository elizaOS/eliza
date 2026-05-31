import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_PROVIDER_CATALOG,
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  normalizeFirstRunProviderId,
} from "./first-run-options";
import { isLinkedAccountProviderId } from "./service-routing";

// Cerebras is an OpenAI-compatible BYOK provider surfaced through the
// provider switcher as a `cerebras-api` direct account (the same shape as
// `moonshot-api`). These assertions lock in every catalog/contract slot the
// end-to-end flow depends on so a future refactor can't silently drop one.
describe("Cerebras first-run provider", () => {
  const entry = FIRST_RUN_PROVIDER_CATALOG.find((p) => p.id === "cerebras");

  it("is registered as an OpenAI-compatible api-key provider", () => {
    expect(entry).toBeDefined();
    expect(entry?.envKey).toBe("CEREBRAS_API_KEY");
    expect(entry?.pluginName).toBe("@elizaos/plugin-openai");
    expect(entry?.authMode).toBe("api-key");
    expect(entry?.group).toBe("local");
    expect(entry?.family).toBe("cerebras");
  });

  it("normalizes its id (case-insensitively)", () => {
    expect(normalizeFirstRunProviderId("cerebras")).toBe("cerebras");
    expect(normalizeFirstRunProviderId("CEREBRAS")).toBe("cerebras");
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
