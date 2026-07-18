/**
 * Verifies the LifeOps runtime hook installs the built-in passive signal
 * sources once and augments registries contributed by its host.
 */

import { AgentRuntime } from "@elizaos/core";
import { LIFEOPS_ACTIVITY_SIGNAL_SOURCES } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  createSignalSourceRegistry,
  getSignalSourceRegistry,
  registerSignalSourceRegistry,
  type SignalSourceContribution,
} from "./lifeops/registries/signal-source-registry.js";
import { registerPersonalAssistantRuntimeHooks } from "./register-runtime.js";

const contributedSource: SignalSourceContribution = {
  source: "test_contributed_source",
  description: "Test-owned source used to prove host registries are preserved.",
  contributor: "test-host",
  telemetryMapper: () => null,
  reliability: () => 1,
};

function makeRuntime(): AgentRuntime {
  return new AgentRuntime({
    character: { name: "lifeops-registry-test" },
    disableBasicCapabilities: true,
    logLevel: "fatal",
  });
}

describe("registerPersonalAssistantRuntimeHooks", () => {
  it("installs every built-in signal source and is idempotent", async () => {
    const runtime = makeRuntime();

    await registerPersonalAssistantRuntimeHooks(runtime);
    const installed = getSignalSourceRegistry(runtime);
    await registerPersonalAssistantRuntimeHooks(runtime);

    expect(installed).not.toBeNull();
    expect(getSignalSourceRegistry(runtime)).toBe(installed);
    expect(installed?.sources().sort()).toEqual(
      [...LIFEOPS_ACTIVITY_SIGNAL_SOURCES].sort(),
    );
  });

  it("preserves host contributions while adding missing built-ins", async () => {
    const runtime = makeRuntime();
    const existing = createSignalSourceRegistry();
    existing.register(contributedSource);
    registerSignalSourceRegistry(runtime, existing);

    await registerPersonalAssistantRuntimeHooks(runtime);

    expect(getSignalSourceRegistry(runtime)).toBe(existing);
    expect(existing.get(contributedSource.source)).toBe(contributedSource);
    expect(existing.sources().sort()).toEqual(
      ["test_contributed_source", ...LIFEOPS_ACTIVITY_SIGNAL_SOURCES].sort(),
    );
  });
});
