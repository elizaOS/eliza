// Exercises provider alignment behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_NATIVE_OAUTH_PROVIDERS,
  OAUTH_PROVIDERS as CORE_OAUTH_PROVIDERS,
} from "@elizaos/core";
import { getAllProviderIds } from "./provider-registry";
import { VENDOR_REGISTRY } from "./vendor-registry";

/**
 * Enforces #8909: every provider the core OAuth atomic actions accept must be
 * serviceable by the cloud OAuth registry — otherwise `CREATE_OAUTH_INTENT`
 * would compile/validate a provider that no cloud handler can complete.
 *
 * `CONNECTOR_NATIVE_OAUTH_PROVIDERS` (e.g. discord) are serviced by their own
 * connector, not the cloud registry, so they are the only allowed exceptions.
 */
describe("core OAuthProvider ⊆ cloud OAuth registry", () => {
  const cloudProviderIds = new Set<string>([
    ...getAllProviderIds(),
    ...Object.keys(VENDOR_REGISTRY),
  ]);
  const connectorNative = new Set<string>(CONNECTOR_NATIVE_OAUTH_PROVIDERS);
  const servicedByCloud = CORE_OAUTH_PROVIDERS.filter((p) => !connectorNative.has(p));

  test("every cloud-serviced core provider exists in the cloud registry", () => {
    const missing = servicedByCloud.filter((p) => !cloudProviderIds.has(p));
    expect(missing).toEqual([]);
  });

  test("github (the #8909 ask) is aligned across both layers", () => {
    expect(CORE_OAUTH_PROVIDERS).toContain("github");
    expect(cloudProviderIds.has("github")).toBe(true);
  });

  test("the previously-missing providers (notion, slack) are aligned", () => {
    for (const p of ["notion", "slack"] as const) {
      expect(CORE_OAUTH_PROVIDERS).toContain(p);
      expect(cloudProviderIds.has(p)).toBe(true);
    }
  });

  test("connector-native exceptions are a subset of the core enum", () => {
    for (const p of CONNECTOR_NATIVE_OAUTH_PROVIDERS) {
      expect(CORE_OAUTH_PROVIDERS).toContain(p);
    }
  });
});
