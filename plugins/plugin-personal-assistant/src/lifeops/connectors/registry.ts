import type { IAgentRuntime } from "@elizaos/core";
import type {
  ConnectorContribution,
  ConnectorRegistry,
  ConnectorRegistryFilter,
} from "./contract.js";

/**
 * In-memory implementation of {@link ConnectorRegistry}. One instance per
 * runtime; populated by `plugin-health` and the connector default pack.
 */
class InMemoryConnectorRegistry implements ConnectorRegistry {
  private readonly byKind = new Map<string, ConnectorContribution>();

  register(c: ConnectorContribution): void {
    if (!c.kind) {
      throw new Error("ConnectorContribution.kind is required");
    }
    if (this.byKind.has(c.kind)) {
      throw new Error(`Connector "${c.kind}" already registered`);
    }
    this.byKind.set(c.kind, c);
  }

  list(filter?: ConnectorRegistryFilter): ConnectorContribution[] {
    const all = Array.from(this.byKind.values());
    if (!filter) {
      return all;
    }
    return all.filter((c) => {
      if (filter.capability && !c.capabilities.includes(filter.capability)) {
        return false;
      }
      if (filter.mode && !c.modes.includes(filter.mode)) {
        return false;
      }
      return true;
    });
  }

  get(kind: string): ConnectorContribution | null {
    return this.byKind.get(kind) ?? null;
  }

  byCapability(capability: string): ConnectorContribution[] {
    return Array.from(this.byKind.values()).filter((c) =>
      c.capabilities.includes(capability),
    );
  }
}

export function createConnectorRegistry(): ConnectorRegistry {
  return new InMemoryConnectorRegistry();
}

/**
 * Per-runtime registry registration. The pattern mirrors
 * `registerSendPolicy` in `@elizaos/core` — a `WeakMap` keyed by runtime so
 * the lifetime tracks the runtime and we don't leak across tests.
 */
const registries = new WeakMap<IAgentRuntime, ConnectorRegistry>();

export function registerConnectorRegistry(
  runtime: IAgentRuntime,
  registry: ConnectorRegistry,
): void {
  registries.set(runtime, registry);
}

export function getConnectorRegistry(
  runtime: IAgentRuntime,
): ConnectorRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetConnectorRegistryForTests(runtime: IAgentRuntime): void {
  registries.delete(runtime);
}
