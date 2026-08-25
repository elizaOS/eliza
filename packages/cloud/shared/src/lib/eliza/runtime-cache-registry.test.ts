/**
 * Runtime cache registry contract.
 *
 * runtime-factory registers cache-invalidation actions after the factory
 * singleton exists; cache and OAuth modules call through the registry so they
 * never import runtime-factory directly (breaks circular imports). The
 * registry must fail closed with a descriptive error before registration —
 * a silent no-op would drop an invalidation and leave a stale agent runtime
 * alive after its credentials or organization were revoked.
 */

import { describe, expect, test } from "bun:test";

import {
  invalidateOrganizationRuntimesFromRegistry,
  invalidateRuntimeFromRegistry,
  registerRuntimeCacheActions,
} from "./runtime-cache-registry";

const AGENT_ID = "agent-42";
const ORG_ID = "org-7";

// Module-level registry state is order-dependent by design: the unregistered
// fail-closed path must be asserted first, then registration, then forwarding.
describe("runtime cache registry", () => {
  test("invalidateRuntimeFromRegistry fails closed before registration", async () => {
    await expect(invalidateRuntimeFromRegistry(AGENT_ID)).rejects.toThrow(
      "[RuntimeCacheRegistry] registerRuntimeCacheActions was not called (runtime-factory not loaded)",
    );
  });

  test("invalidateOrganizationRuntimesFromRegistry fails closed before registration", async () => {
    await expect(invalidateOrganizationRuntimesFromRegistry(ORG_ID)).rejects.toThrow(
      "[RuntimeCacheRegistry] registerRuntimeCacheActions was not called (runtime-factory not loaded)",
    );
  });

  test("registered actions receive invalidateRuntime calls", async () => {
    const seen: string[] = [];
    registerRuntimeCacheActions({
      invalidateRuntime: async (agentId: string) => {
        seen.push(agentId);
        return true;
      },
      invalidateByOrganization: async () => 0,
    });

    const result = await invalidateRuntimeFromRegistry(AGENT_ID);

    expect(result).toBe(true);
    expect(seen).toEqual([AGENT_ID]);
  });

  test("registered actions receive invalidateByOrganization calls and their count", async () => {
    const seen: string[] = [];
    registerRuntimeCacheActions({
      invalidateRuntime: async () => false,
      invalidateByOrganization: async (organizationId: string) => {
        seen.push(organizationId);
        return 3;
      },
    });

    const result = await invalidateOrganizationRuntimesFromRegistry(ORG_ID);

    expect(result).toBe(3);
    expect(seen).toEqual([ORG_ID]);
  });

  test("a rejection from the registered action propagates to the caller", async () => {
    registerRuntimeCacheActions({
      invalidateRuntime: async () => {
        throw new Error("runtime teardown failed");
      },
      invalidateByOrganization: async () => 0,
    });

    await expect(invalidateRuntimeFromRegistry(AGENT_ID)).rejects.toThrow(
      "runtime teardown failed",
    );
  });
});
