/**
 * Regression: the manager must classify a provider-switch using the provider
 * state that existed BEFORE `prepare()` runs.
 *
 * The provider-switch route's `prepare()` mutates the live config to the
 * target provider. If the manager snapshots the classify context AFTER
 * prepare(), `currentProvider` always equals the target → every switch
 * collapses to "hot". A hot reload only notifies already-loaded plugins, so
 * switching to a provider whose plugin was never loaded (e.g. elizacloud →
 * cerebras, or onboarding the very first provider) would leave the runtime
 * with no provider registered until a full restart.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultClassifier } from "../../../src/runtime/operations/classifier.js";
import { HealthChecker } from "../../../src/runtime/operations/health.js";
import { DefaultRuntimeOperationManager } from "../../../src/runtime/operations/manager.js";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.js";
import type {
  ProviderSwitchIntent,
  ReloadStrategy,
  ReloadTier,
} from "../../../src/runtime/operations/types.js";

let stateDir: string;
let repo: FilesystemRuntimeOperationRepository;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "classify-ordering-"));
  repo = new FilesystemRuntimeOperationRepository(stateDir, {
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    maxRecords: 1000,
  });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function stubStrategy(tier: ReloadTier): ReloadStrategy {
  return { tier, apply: async () => ({}) as unknown as AgentRuntime };
}

describe("manager classifies provider-switch from the pre-prepare provider", () => {
  test("elizacloud → cerebras stays cold even though prepare() rewrites currentProvider to the target", async () => {
    // The live provider before the switch.
    let currentProvider = "elizacloud";

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "cerebras",
    };

    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => ({}) as unknown as AgentRuntime,
      // Reads the live provider at call time — exactly like the real
      // server closure that reads from `state.config`.
      classifyContext: () => ({ currentProvider }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: { cold: stubStrategy("cold"), hot: stubStrategy("hot") },
    });

    const outcome = await manager.start({
      intent,
      // Mirrors the route: prepare() applies the target provider to config,
      // which the classify context reads from.
      prepare: async () => {
        currentProvider = "cerebras";
        return intent;
      },
    });

    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    // Pre-prepare provider was elizacloud (different family) → cold restart,
    // which actually loads the cerebras plugin. The bug would yield "hot".
    expect(outcome.operation.tier).toBe("cold");
  });

  test("same-provider key swap still collapses to hot", async () => {
    let currentProvider = "openai";
    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
    };
    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => ({}) as unknown as AgentRuntime,
      classifyContext: () => ({ currentProvider }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: { cold: stubStrategy("cold"), hot: stubStrategy("hot") },
    });
    const outcome = await manager.start({
      intent,
      prepare: async () => {
        currentProvider = "openai";
        return intent;
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.operation.tier).toBe("hot");
  });
});
