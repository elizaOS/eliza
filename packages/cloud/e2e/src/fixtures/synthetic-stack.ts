/** Boots the manifest-owned synthetic world and its strict model/provider sidecars for Cloud E2E. */

import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  type ProviderProtocolFixture,
  type RunningFakeProvider,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import {
  AgentRuntime,
  type JsonValue as CoreJsonValue,
  InMemoryDatabaseAdapter,
  ModelType,
} from "@elizaos/core";
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
  /** Executable readiness through the production Cloud SDK client. */
  productionProbe?: {
    client: "cloud-sdk";
    method: "GET";
    path: string;
    expectedBody: JsonValue;
  };
}

export type CloudSyntheticConnector = "cloud-agent-bridge";

export interface SyntheticRuntimeReadinessReceipt {
  agentId: string;
  modelType: typeof ModelType.TEXT_LARGE;
  responseHash: string;
}

export interface SyntheticProviderReadinessReceipt {
  providerId: string;
  client: "cloud-sdk";
  method: "GET";
  path: string;
  responseHash: string;
  ledgerRequestCount: number;
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
  connectors: CloudSyntheticConnector[];
  backgroundWorkers: Array<"cloud-api" | "container-control-plane">;
  frontendTargets: Array<"app">;
  providers: CloudSyntheticProviderBinding[];
  faultScript: WorldManifest["faults"];
}

export interface RunningSyntheticStack {
  world: SyntheticWorld;
  model?: RunningMockLlm;
  providers: ReadonlyMap<string, RunningFakeProvider>;
  runtimes: readonly AgentRuntime[];
  runtimeReadiness: readonly SyntheticRuntimeReadinessReceipt[];
  providerReadiness: readonly SyntheticProviderReadinessReceipt[];
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
  let runtimes: AgentRuntime[] = [];
  let runtimeReadiness: SyntheticRuntimeReadinessReceipt[] = [];
  let providerReadiness: SyntheticProviderReadinessReceipt[] = [];
  const runtimeProbePrompt = `cloud synthetic runtime readiness:${manifest.worldId}`;
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
        fixtures: [
          ...(input.agentCount > 0
            ? [
                {
                  name: "__cloud_runtime_readiness__",
                  match: {
                    modelType: ModelType.TEXT_LARGE,
                    input: runtimeProbePrompt,
                  },
                  response: "cloud synthetic runtime ready",
                  times: input.agentCount,
                } satisfies DeterministicModelFixture,
              ]
            : []),
          ...input.model.fixtures,
        ],
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

  const stopRuntimes = async (): Promise<Error[]> => {
    const current = runtimes;
    runtimes = [];
    runtimeReadiness = [];
    const results = await Promise.allSettled(
      current.map(async (runtime) => {
        await runtime.stop();
        await runtime.close();
      }),
    );
    return results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          ]
        : [],
    );
  };

  const bootRuntimes = async (): Promise<void> => {
    if (input.agentCount === 0) return;
    if (!model)
      throw new Error("synthetic runtime boot requires the strict model wire");
    const { default: openaiPlugin } = await import("@elizaos/plugin-openai");
    const booted: AgentRuntime[] = [];
    const receipts: SyntheticRuntimeReadinessReceipt[] = [];
    try {
      for (let index = 0; index < input.agentCount; index += 1) {
        const runtime = new AgentRuntime({
          character: { name: `CloudSyntheticAgent${index + 1}` },
          adapter: new InMemoryDatabaseAdapter(),
          logLevel: "fatal",
          enableAutonomy: false,
        });
        runtime.setSetting("SECRET_SALT", `cloud-synthetic-${manifest.seed}`);
        runtime.setSetting("OPENAI_API_KEY", "synthetic-model-key", true);
        runtime.setSetting("OPENAI_BASE_URL", model.url);
        runtime.setSetting("OPENAI_LARGE_MODEL", "synthetic-readiness-model");
        booted.push(runtime);
        await runtime.registerPlugin(openaiPlugin);
        await runtime.initialize();
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: runtimeProbePrompt,
        });
        if (response !== "cloud synthetic runtime ready") {
          throw new Error(
            `synthetic runtime ${runtime.agentId} returned an invalid readiness response`,
          );
        }
        receipts.push({
          agentId: runtime.agentId,
          modelType: ModelType.TEXT_LARGE,
          responseHash: payloadHash(response),
        });
      }
    } catch (error) {
      await Promise.allSettled(
        booted.map(async (runtime) => {
          await runtime.stop();
          await runtime.close();
        }),
      );
      throw error;
    }
    runtimes = booted;
    runtimeReadiness = receipts;
  };

  const runProviderProbes = async (): Promise<void> => {
    const receipts: SyntheticProviderReadinessReceipt[] = [];
    for (const binding of input.providers) {
      const probe = binding.productionProbe;
      if (!probe) continue;
      const provider = providers.get(binding.id);
      if (!provider) throw new Error(`missing booted provider ${binding.id}`);
      const client = new CloudApiClient(
        provider.url,
        binding.apiKey ?? "synthetic-provider-key",
      );
      const body = await client.get<CoreJsonValue>(probe.path);
      const responseHash = payloadHash(body as JsonValue);
      if (responseHash !== payloadHash(probe.expectedBody)) {
        throw new Error(
          `production probe for ${binding.id} returned an unexpected body`,
        );
      }
      const snapshot = await provider.control.snapshot();
      const ledger = snapshot.state.ledger as
        | { requests?: Array<{ method?: string; path?: string }> }
        | undefined;
      const requests = ledger?.requests ?? [];
      const observed = requests.at(-1);
      if (observed?.method !== probe.method || observed.path !== probe.path) {
        throw new Error(
          `production probe for ${binding.id} was not observed in the provider ledger`,
        );
      }
      receipts.push({
        providerId: binding.id,
        client: probe.client,
        method: probe.method,
        path: probe.path,
        responseHash,
        ledgerRequestCount: requests.length,
      });
    }
    providerReadiness = receipts;
  };

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
      runtimes: runtimeReadiness,
      providerReadiness,
    } as unknown as JsonValue);
  };
  const firstProvider = providers.values().next().value;
  try {
    if (firstProvider) await firstProvider.control.resetWorld();
    else world.reset();
    model?.resetFixtures();
    await bootRuntimes();
    await runProviderProbes();
  } catch (error) {
    await Promise.allSettled([
      stopRuntimes(),
      ...(model ? [model.stop()] : []),
      ...[...providers.values()].map((provider) => provider.stop()),
    ]);
    world.teardown();
    throw error;
  }
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
    get runtimes() {
      return runtimes;
    },
    get runtimeReadiness() {
      return runtimeReadiness;
    },
    get providerReadiness() {
      return providerReadiness;
    },
    bootstrap: processEnv.ELIZA_SYNTHETIC_WORLD_BOOTSTRAP,
    processEnv,
    initialStateHash,
    initialExecutionStateHash,
    assertModelConsumptionPerTest:
      input.model.mode === "mock-strict" &&
      input.model.assertConsumption === "per-test",
    executionStateHash,
    async reset(): Promise<void> {
      const runtimeErrors = await stopRuntimes();
      if (runtimeErrors.length > 0) {
        throw new AggregateError(
          runtimeErrors,
          "synthetic runtime reset teardown failed",
        );
      }
      if (firstProvider) await firstProvider.control.resetWorld();
      else world.reset();
      model?.resetFixtures();
      await bootRuntimes();
      await runProviderProbes();
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
        stopRuntimes().then((errors) => {
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "synthetic runtime teardown failed",
            );
          }
        }),
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
  if (new Set(input.connectors).size !== input.connectors.length) {
    throw new Error(
      "synthetic Cloud stack connector declarations must be unique",
    );
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
    if (provider.productionProbe) {
      if (
        !provider.productionProbe.path.startsWith("/") ||
        provider.productionProbe.path.includes("?")
      ) {
        throw new Error(
          "synthetic production probe paths must be absolute and query-free",
        );
      }
      const fixture = provider.fixtures.find(
        (candidate) =>
          candidate.method === provider.productionProbe?.method &&
          candidate.path === provider.productionProbe.path,
      );
      if (!fixture) {
        throw new Error(
          `synthetic production probe for ${provider.id} has no matching fixture`,
        );
      }
    }
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
