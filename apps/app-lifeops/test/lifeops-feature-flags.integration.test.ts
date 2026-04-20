import { afterEach, describe, expect, it } from "vitest";
import { createFeatureFlagService } from "../src/lifeops/feature-flags.ts";
import {
  ALL_FEATURE_KEYS,
  FEATURE_DEFAULTS,
} from "../src/lifeops/feature-flags.types.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

describe("LifeOps feature flag schema integration", () => {
  let runtimeResult: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | null =
    null;

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
      expect(state.enabled).toBe(FEATURE_DEFAULTS[state.featureKey].enabled);
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
});
