/** Boots the manifest-owned synthetic world and its strict model/provider sidecars for Cloud E2E. */

import {
  type ProviderProtocolFixture,
  type RunningFakeProvider,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import type { DeterministicModelFixture } from "@elizaos/core/testing";
import {
  bootInProcessWorld,
  createProcessBootstrap,
  type JsonValue,
  parseWorldManifest,
  payloadHash,
  type SyntheticWorld,
  serializeProcessBootstrap,
  type WorldManifest,
} from "@elizaos/synthetic-world";
import { type RunningMockLlm, startMockLlm } from "./mock-llm";

export interface CloudSyntheticProviderBinding {
  id: string;
  baseUrlEnv: string;
  apiKeyEnv?: string;
  apiKey?: string;
  fixtures: ProviderProtocolFixture[];
}

export interface CloudSyntheticStackManifest {
  world: WorldManifest;
  model:
    | {
        mode: "mock-strict";
        fixtures: DeterministicModelFixture[];
        assertConsumption: "per-test" | "at-stop";
      }
    | { mode: "real"; provider: string; model: string };
  agentCount: number;
  connectors: string[];
  backgroundWorkers: Array<"cloud-api" | "container-control-plane">;
  frontendTargets: Array<"app">;
  providers: CloudSyntheticProviderBinding[];
  faultScript: WorldManifest["faults"];
}

export interface RunningSyntheticStack {
  world: SyntheticWorld;
  model?: RunningMockLlm;
  providers: ReadonlyMap<string, RunningFakeProvider>;
  bootstrap: string;
  processEnv: Readonly<Record<string, string>>;
  initialStateHash: string;
  initialExecutionStateHash: string;
  assertModelConsumptionPerTest: boolean;
  executionStateHash(): Promise<string>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startSyntheticStack(
  input: CloudSyntheticStackManifest,
  runId: string,
): Promise<RunningSyntheticStack> {
  const manifest = parseWorldManifest({
    ...input.world,
    faults: input.faultScript,
  });
  assertStackManifest(input);
  const bootstrap = createProcessBootstrap(manifest, "cloud-e2e", { runId });
  const world = bootInProcessWorld(manifest, {
    namespace: bootstrap.namespace,
  });
  const providers = new Map<string, RunningFakeProvider>();
  let model: RunningMockLlm | undefined;
  try {
    for (const binding of input.providers) {
      providers.set(
        binding.id,
        await startFakeProvider({
          providerId: binding.id,
          world,
          fixtures: binding.fixtures,
        }),
      );
    }
    if (input.model.mode === "mock-strict") {
      model = await startMockLlm({
        scenarioId: `cloud-e2e:${manifest.worldId}`,
        attemptId: runId,
        worldId: manifest.worldId,
        fixtures: input.model.fixtures,
      });
    }
  } catch (error) {
    await Promise.allSettled(
      [...providers.values()].map((item) => item.stop()),
    );
    world.teardown();
    throw error;
  }
  const processEnv: Record<string, string> = {
    ELIZA_SYNTHETIC_AGENT_COUNT: String(input.agentCount),
    ELIZA_SYNTHETIC_CONNECTORS: input.connectors.join(","),
    ELIZA_SYNTHETIC_BACKGROUND_WORKERS: input.backgroundWorkers.join(","),
    ELIZA_SYNTHETIC_WORLD_BOOTSTRAP: serializeProcessBootstrap(bootstrap),
    ELIZA_SYNTHETIC_WORLD_BOOTSTRAP_HASH: bootstrap.manifestHash,
  };
  const providerBindingNames: string[] = [];
  for (const binding of input.providers) {
    const provider = providers.get(binding.id);
    if (!provider) throw new Error(`missing booted provider ${binding.id}`);
    processEnv[binding.baseUrlEnv] = provider.url;
    providerBindingNames.push(binding.baseUrlEnv);
    if (binding.apiKeyEnv) {
      processEnv[binding.apiKeyEnv] =
        binding.apiKey ?? "synthetic-provider-key";
      providerBindingNames.push(binding.apiKeyEnv);
    }
  }
  processEnv.ELIZA_SYNTHETIC_PROVIDER_BINDINGS = providerBindingNames
    .sort()
    .join(",");
  if (model) {
    processEnv.OPENAI_API_KEY = "synthetic-model-key";
    processEnv.OPENAI_BASE_URL = model.url;
  }

  const executionStateHash = async (): Promise<string> => {
    const providerStates = await Promise.all(
      [...providers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          async ([id, provider]) =>
            [id, await provider.control.snapshot()] as const,
        ),
    );
    return payloadHash({
      world: {
        stateHash: world.stateHash,
        executionStateHash: world.executionStateHash,
      },
      providers: Object.fromEntries(
        providerStates.map(([id, state]) => [
          id,
          {
            executionStateHash: state.executionStateHash,
          },
        ]),
      ),
      model: model
        ? {
            requestCount: model.requestCount(),
            diagnostics: model.diagnostics(),
          }
        : { mode: "real" },
    } as unknown as JsonValue);
  };
  const firstProvider = providers.values().next().value;
  if (firstProvider) await firstProvider.control.resetWorld();
  else world.reset();
  model?.resetFixtures();
  const initialStateHash = world.stateHash;
  const initialExecutionStateHash = await executionStateHash();
  const assertModelConsumptionAtStop =
    input.model.mode === "mock-strict" &&
    input.model.assertConsumption === "at-stop";
  let stopped = false;
  return {
    world,
    model,
    providers,
    bootstrap: processEnv.ELIZA_SYNTHETIC_WORLD_BOOTSTRAP,
    processEnv,
    initialStateHash,
    initialExecutionStateHash,
    assertModelConsumptionPerTest:
      input.model.mode === "mock-strict" &&
      input.model.assertConsumption === "per-test",
    executionStateHash,
    async reset(): Promise<void> {
      if (firstProvider) await firstProvider.control.resetWorld();
      else world.reset();
      model?.resetFixtures();
      if (
        world.stateHash !== initialStateHash ||
        (await executionStateHash()) !== initialExecutionStateHash
      ) {
        throw new Error(
          "synthetic Cloud stack reset did not restore initial execution state",
        );
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      const assertionErrors: Error[] = [];
      if (assertModelConsumptionAtStop && model) {
        try {
          model.assertFixturesConsumed();
        } catch (error) {
          assertionErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      const results = await Promise.allSettled([
        ...(model ? [model.stop()] : []),
        ...[...providers.values()].map((provider) => provider.stop()),
      ]);
      world.teardown();
      const errors = [
        ...assertionErrors,
        ...results.flatMap((result) =>
          result.status === "rejected"
            ? [
                result.reason instanceof Error
                  ? result.reason
                  : new Error(String(result.reason)),
              ]
            : [],
        ),
      ];
      if (errors.length > 0) {
        throw new AggregateError(errors, "synthetic sidecar teardown failed");
      }
    },
  };
}

function assertStackManifest(input: CloudSyntheticStackManifest): void {
  if (!Number.isSafeInteger(input.agentCount) || input.agentCount < 0) {
    throw new Error(
      "synthetic Cloud stack agentCount must be a non-negative integer",
    );
  }
  if (input.agentCount !== 0) {
    throw new Error("synthetic Cloud stack agent processes are not wired yet");
  }
  if (input.connectors.length !== 0) {
    throw new Error("synthetic Cloud stack connectors are not wired yet");
  }
  if (
    [...input.backgroundWorkers].sort().join(",") !==
    "cloud-api,container-control-plane"
  ) {
    throw new Error(
      "synthetic Cloud stack currently requires cloud-api and container-control-plane workers",
    );
  }
  if (input.model.mode === "real") {
    throw new Error("synthetic Cloud stack real model mode is not wired yet");
  }
  if (input.model.mode === "mock-strict" && input.model.fixtures.length === 0) {
    throw new Error("synthetic Cloud stack requires strict model fixtures");
  }
  const ids = new Set<string>();
  const env = new Set<string>();
  for (const provider of input.providers) {
    if (!provider.id.trim() || ids.has(provider.id)) {
      throw new Error("synthetic provider ids must be unique and non-empty");
    }
    ids.add(provider.id);
    for (const name of [provider.baseUrlEnv, provider.apiKeyEnv].filter(
      Boolean,
    ) as string[]) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || env.has(name)) {
        throw new Error(
          "synthetic provider env bindings must be unique uppercase names",
        );
      }
      env.add(name);
    }
  }
}
