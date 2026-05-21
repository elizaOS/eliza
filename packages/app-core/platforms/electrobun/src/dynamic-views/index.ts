import { createDynamicViewHost, type DynamicViewHost } from "./host";
import { DynamicViewRegistry } from "./registry";
import { DynamicViewSessionManager } from "./session-manager";
import type { DynamicViewManifest } from "./types";

const registry = new DynamicViewRegistry();

let sessionManager: DynamicViewSessionManager | null = null;
let builtInsRegistered = false;

export function getDynamicViewRegistry(): DynamicViewRegistry {
  return registry;
}

export function getDynamicViewSessionManager(
  options: ConstructorParameters<typeof DynamicViewSessionManager>[0],
): DynamicViewSessionManager {
  if (!sessionManager) {
    sessionManager = new DynamicViewSessionManager(options);
  }
  return sessionManager;
}

export function resetDynamicViewStateForTests(): void {
  for (const manifest of registry.list()) {
    registry.unregister(manifest.id);
  }
  sessionManager = null;
  builtInsRegistered = false;
}

export function registerBuiltInDynamicViews(): DynamicViewManifest[] {
  if (builtInsRegistered) return registry.list();
  const demoManifest: DynamicViewManifest = {
    id: "agent.run.trace.demo",
    title: "Agent Run Trace Demo",
    description: "Developer demo for agent-created dynamic views.",
    source: "developer",
    entrypoint: "./demo/agent-run-trace.html",
    placement: "floating",
    requiredRemotes: ["eliza.runtime"],
    eventSubscriptions: [{ remoteId: "eliza.runtime" }],
    invokeTargets: ["eliza.runtime"],
    metadata: {
      demo: true,
    },
  };
  registry.register(demoManifest, { update: true });
  builtInsRegistered = true;
  return registry.list();
}

export function createDynamicViewHostForRuntime(
  sessions: DynamicViewSessionManager,
): DynamicViewHost {
  return createDynamicViewHost({ registry, sessions });
}
