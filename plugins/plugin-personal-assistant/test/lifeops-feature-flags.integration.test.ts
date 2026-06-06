import type { IAgentRuntime, Service } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFeatureFlagService } from "../src/lifeops/feature-flags.ts";
import {
  ALL_FEATURE_KEYS,
  BASE_FEATURE_DEFAULTS,
  CLOUD_LINKED_DEFAULT_ON,
  isLifeOpsFeatureKey,
  resolveFeatureDefaults,
} from "../src/lifeops/feature-flags.types.ts";
import { executeRawSql } from "../src/lifeops/sql.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

interface MockCloudAuth {
  isAuthenticated(): boolean;
}

/**
 * Wrap a real lifeops runtime with a fake CLOUD_AUTH service so the
 * feature-flag service believes the user is signed in. Other services
 * are passed through unchanged so SQL still works.
 */
function withMockCloudAuth(
  runtime: IAgentRuntime,
  authenticated: boolean,
): IAgentRuntime {
  const mockAuth = {
    isAuthenticated: () => authenticated,
  } as Service & MockCloudAuth;
  const original = runtime.getService.bind(runtime);
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === "getService") {
        return <T extends Service>(serviceType: string): T | null => {
          if (serviceType === "CLOUD_AUTH") {
            return mockAuth as T;
          }
          return original<T>(serviceType);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("LifeOps feature flag schema integration", () => {
  let runtimeResult: Awaited<
    ReturnType<typeof createLifeOpsTestRuntime>
  > | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("reads compile-time defaults from a fresh runtime and persists overrides via the plugin schema", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const service = createFeatureFlagService(runtimeResult.runtime);

    const states = await service.list();
    expect(states).toHaveLength(ALL_FEATURE_KEYS.length);
    for (const state of states) {
      expect(isLifeOpsFeatureKey(state.featureKey)).toBe(true);
      if (!isLifeOpsFeatureKey(state.featureKey)) continue;
      expect(state.enabled).toBe(
        BASE_FEATURE_DEFAULTS[state.featureKey].enabled,
      );
      expect(state.source).toBe("default");
    }

    const enabled = await service.enable(
      "notifications.push",
      "local",
      runtimeResult.runtime.agentId,
      { channel: "ntfy" },
    );
    expect(enabled.enabled).toBe(true);
    expect(enabled.source).toBe("local");
    expect(enabled.enabledBy).toBe(runtimeResult.runtime.agentId);
    expect(enabled.metadata).toEqual({ channel: "ntfy" });

    const roundTrip = await service.get("notifications.push");
    expect(roundTrip.enabled).toBe(true);
    expect(roundTrip.source).toBe("local");
    expect(roundTrip.enabledBy).toBe(runtimeResult.runtime.agentId);
    expect(roundTrip.metadata).toEqual({ channel: "ntfy" });
  });

  it("rejects unknown persisted feature keys instead of skipping them", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await executeRawSql(
      runtimeResult.runtime,
      `INSERT INTO lifeops_features (
            feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at
          ) VALUES (
            'made_up.feature', TRUE, 'local', now(), NULL, '{}'::jsonb, now(), now()
          )`,
    );

    const service = createFeatureFlagService(runtimeResult.runtime);
    await expect(service.list()).rejects.toThrow(
      /Unknown feature flag 'made_up\.feature'/,
    );
  });
});

describe("resolveFeatureDefaults Cloud-link policy", () => {
  it("returns the conservative baseline when cloudLinked is false", () => {
    const defaults = resolveFeatureDefaults({ cloudLinked: false });
    for (const key of ALL_FEATURE_KEYS) {
      expect(defaults[key].enabled).toBe(BASE_FEATURE_DEFAULTS[key].enabled);
    }
    expect(defaults["travel.book_flight"].enabled).toBe(false);
    expect(defaults["travel.book_hotel"].enabled).toBe(false);
    expect(defaults["cloud.duffel"].enabled).toBe(false);
  });

  it("flips travel + cloud.duffel ON when cloudLinked is true", () => {
    const defaults = resolveFeatureDefaults({ cloudLinked: true });
    for (const key of CLOUD_LINKED_DEFAULT_ON) {
      expect(defaults[key].enabled).toBe(true);
    }
    // Non-promoted keys keep their baseline.
    expect(defaults["notifications.push"].enabled).toBe(false);
    expect(defaults["browser.automation"].enabled).toBe(false);
  });
});

describe("FeatureFlagService cloud-aware defaults", () => {
  let runtimeResult: Awaited<
    ReturnType<typeof createLifeOpsTestRuntime>
  > | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("isEnabled('travel.book_flight') returns true with no DB row when CLOUD_AUTH reports authenticated", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const cloudLinkedRuntime = withMockCloudAuth(runtimeResult.runtime, true);
    const service = createFeatureFlagService(cloudLinkedRuntime);

    expect(await service.isEnabled("travel.book_flight")).toBe(true);
    expect(await service.isEnabled("travel.book_hotel")).toBe(true);
    expect(await service.isEnabled("cloud.duffel")).toBe(true);
    // Non-Cloud-default keys still respect the baseline.
    expect(await service.isEnabled("notifications.push")).toBe(false);
  });

  it("isEnabled('travel.book_flight') stays false when CLOUD_AUTH is missing", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const service = createFeatureFlagService(runtimeResult.runtime);
    expect(await service.isEnabled("travel.book_flight")).toBe(false);
  });
});
