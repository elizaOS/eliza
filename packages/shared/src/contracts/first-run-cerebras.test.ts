import { describe, expect, it } from "vitest";
// Core is the innermost package (`packages/shared` depends on `@elizaos/core`,
// never the reverse), so the first-run provider catalog is duplicated in both:
// `packages/core/src/contracts/first-run-options.ts` is the canonical copy and
// `packages/shared/src/contracts/first-run-options.ts` is the shared mirror.
// These two MUST stay identical — when they drift, core's own
// `normalizeFirstRunProviderId`/migration helpers silently miss the newer
// providers (Cerebras was exactly this bug). Import both here and assert
// equality so any future divergence fails CI in this package.
import {
  FIRST_RUN_PROVIDER_CATALOG as CORE_CATALOG,
  DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER as CORE_DIRECT_ACCOUNT_MAP,
  getDirectAccountProviderForFirstRunProvider as coreGetDirectAccountProvider,
  normalizeFirstRunProviderId as coreNormalizeFirstRunProviderId,
} from "../../../core/src/contracts/first-run-options";
import {
  DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
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

// Drift guard: the shared mirror must match the canonical core copy exactly.
// If a provider (or a helper's provider handling) is added to one file but not
// the other, these assertions fail. Removing Cerebras from the core copy — the
// original bug — trips both the catalog deep-equal and the normalize check.
describe("first-run provider catalog core/shared alignment", () => {
  it("core and shared expose an identical provider catalog", () => {
    expect(CORE_CATALOG).toEqual(FIRST_RUN_PROVIDER_CATALOG);
    expect(CORE_CATALOG.map((p) => p.id)).toEqual(
      FIRST_RUN_PROVIDER_CATALOG.map((p) => p.id),
    );
  });

  it("core and shared expose an identical direct-account map", () => {
    expect(CORE_DIRECT_ACCOUNT_MAP).toEqual(
      DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
    );
  });

  it("the canonical core copy includes Cerebras", () => {
    const coreCerebras = CORE_CATALOG.find((p) => p.id === "cerebras");
    expect(coreCerebras).toBeDefined();
    expect(coreCerebras?.envKey).toBe("CEREBRAS_API_KEY");
    expect(coreCerebras?.family).toBe("cerebras");
  });

  it("core's normalize + direct-account helpers resolve Cerebras", () => {
    expect(coreNormalizeFirstRunProviderId("cerebras")).toBe("cerebras");
    expect(coreNormalizeFirstRunProviderId("CEREBRAS")).toBe("cerebras");
    expect(coreNormalizeFirstRunProviderId("cerebras-api")).toBe("cerebras");
    expect(coreGetDirectAccountProvider("cerebras")).toBe("cerebras-api");
  });
});
