/**
 * Prepares LifeOps runtime-only deployments by installing passive signals and,
 * at the post-ready registry boundary, migrating the route schema. Full plugin
 * init uses only the signal half because core startup owns migration ordering;
 * route-only hosts call the exported hook after the adapter is ready.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  createSignalSourceRegistry,
  getSignalSourceRegistry,
  registerSignalSourceRegistry,
} from "./lifeops/registries/signal-source-registry.js";
import { ensureLifeOpsSchema } from "./lifeops/schema-bootstrap.js";
import { registerBuiltinSignalSources } from "./lifeops/telemetry-mapping.js";

export function registerPersonalAssistantSignalSources(
  runtime: IAgentRuntime,
): void {
  const installedRegistry = getSignalSourceRegistry(runtime);
  const registry = installedRegistry ?? createSignalSourceRegistry();
  const builtins = createSignalSourceRegistry();
  registerBuiltinSignalSources(builtins);

  for (const contribution of builtins.list()) {
    if (!registry.has(contribution.source)) {
      registry.register(contribution);
    }
  }

  if (installedRegistry === null) {
    registerSignalSourceRegistry(runtime, registry);
  }
}

export async function registerPersonalAssistantRuntimeHooks(
  runtime: IAgentRuntime,
): Promise<void> {
  registerPersonalAssistantSignalSources(runtime);
  await ensureLifeOpsSchema(runtime);
}
