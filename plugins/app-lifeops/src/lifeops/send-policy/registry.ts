import type { IAgentRuntime } from "@elizaos/core";
import type {
  SendPolicyContext,
  SendPolicyContribution,
  SendPolicyDecision,
  SendPolicyRegistry,
  SendPolicyRegistryFilter,
} from "./contract.js";

/**
 * In-memory implementation of {@link SendPolicyRegistry}. One instance per
 * runtime; populated by Wave 2 (W2-B) policy migration.
 *
 * Filter semantics:
 * - {@link list} with `source: "channel"` returns policies that apply to at
 *   least one channel-kind context (i.e. policies whose `appliesTo` returns
 *   `true` for any synthesized channel context, OR policies with no
 *   `appliesTo` predicate, since those run for every context). The simpler
 *   useful interpretation we ship is: `list` with no filter returns every
 *   registered policy in priority order; `list` with a `source` filter
 *   returns the same set since the registry does not store source affinity
 *   metadata. The filter is reserved for Wave 2 once policies declare
 *   per-source affinity explicitly.
 */
class InMemorySendPolicyRegistry implements SendPolicyRegistry {
  private readonly byKind = new Map<string, SendPolicyContribution>();
  private order: SendPolicyContribution[] = [];

  register(c: SendPolicyContribution): void {
    if (!c.kind) {
      throw new Error("SendPolicyContribution.kind is required");
    }
    if (this.byKind.has(c.kind)) {
      throw new Error(`SendPolicy "${c.kind}" already registered`);
    }
    this.byKind.set(c.kind, c);
    this.order = sortByPriority([...this.order, c]);
  }

  list(_filter?: SendPolicyRegistryFilter): SendPolicyContribution[] {
    return [...this.order];
  }

  get(kind: string): SendPolicyContribution | null {
    return this.byKind.get(kind) ?? null;
  }

  async evaluate(context: SendPolicyContext): Promise<SendPolicyDecision> {
    for (const policy of this.order) {
      if (policy.appliesTo && !policy.appliesTo(context)) {
        continue;
      }
      const decision = await policy.evaluate(context);
      if (decision.kind !== "allow") {
        return decision;
      }
    }
    return { kind: "allow" };
  }
}

function sortByPriority(
  policies: SendPolicyContribution[],
): SendPolicyContribution[] {
  // Stable sort by priority (ascending). Policies without a priority retain
  // registration order behind those that declared one.
  const annotated = policies.map((policy, index) => ({ policy, index }));
  annotated.sort((a, b) => {
    const ap = a.policy.priority ?? Number.POSITIVE_INFINITY;
    const bp = b.policy.priority ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.index - b.index;
  });
  return annotated.map(({ policy }) => policy);
}

export function createSendPolicyRegistry(): SendPolicyRegistry {
  return new InMemorySendPolicyRegistry();
}

const registries = new WeakMap<IAgentRuntime, SendPolicyRegistry>();

export function registerSendPolicyRegistry(
  runtime: IAgentRuntime,
  registry: SendPolicyRegistry,
): void {
  registries.set(runtime, registry);
}

export function getSendPolicyRegistry(
  runtime: IAgentRuntime,
): SendPolicyRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetSendPolicyRegistryForTests(
  runtime: IAgentRuntime,
): void {
  registries.delete(runtime);
}
