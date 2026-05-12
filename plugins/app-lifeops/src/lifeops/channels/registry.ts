import type { IAgentRuntime } from "@elizaos/core";
import type {
  ChannelCapabilities,
  ChannelContribution,
  ChannelRegistry,
  ChannelRegistryFilter,
} from "./contract.js";

/**
 * In-memory implementation of {@link ChannelRegistry}. One instance per
 * runtime.
 */
class InMemoryChannelRegistry implements ChannelRegistry {
  private readonly byKind = new Map<string, ChannelContribution>();

  register(c: ChannelContribution): void {
    if (!c.kind) {
      throw new Error("ChannelContribution.kind is required");
    }
    if (this.byKind.has(c.kind)) {
      throw new Error(`Channel "${c.kind}" already registered`);
    }
    this.byKind.set(c.kind, c);
  }

  list(filter?: ChannelRegistryFilter): ChannelContribution[] {
    const all = Array.from(this.byKind.values());
    if (!filter?.supports) {
      return all;
    }
    const supports = filter.supports;
    const required = Object.entries(supports) as Array<
      [keyof ChannelCapabilities, boolean | undefined]
    >;
    return all.filter((channel) =>
      required.every(([cap, want]) => {
        if (want === undefined) return true;
        return channel.capabilities[cap] === want;
      }),
    );
  }

  get(kind: string): ChannelContribution | null {
    return this.byKind.get(kind) ?? null;
  }
}

export function createChannelRegistry(): ChannelRegistry {
  return new InMemoryChannelRegistry();
}

const registries = new WeakMap<IAgentRuntime, ChannelRegistry>();

export function registerChannelRegistry(
  runtime: IAgentRuntime,
  registry: ChannelRegistry,
): void {
  registries.set(runtime, registry);
}

export function getChannelRegistry(
  runtime: IAgentRuntime,
): ChannelRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetChannelRegistryForTests(runtime: IAgentRuntime): void {
  registries.delete(runtime);
}
