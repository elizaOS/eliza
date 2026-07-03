import type { loadElizaConfig } from "@elizaos/agent";
import type { AgentRuntime, UUID } from "@elizaos/core";
import type { AutomationNodeDescriptor } from "@elizaos/ui";

export interface AutomationNodeContributorContext {
  runtime: AgentRuntime;
  config: ReturnType<typeof loadElizaConfig>;
  agentName: string;
  adminEntityId: UUID;
}

export type AutomationNodeContributor = (
  context: AutomationNodeContributorContext,
) => Promise<AutomationNodeDescriptor[]> | AutomationNodeDescriptor[];

/**
 * Declarative spec for an automation node whose availability is gated by a
 * loaded runtime action or plugin. Owning plugins declare their specs and turn
 * them into descriptors via {@link buildRuntimeCapabilityNodes} inside a
 * registered contributor, so a plugin owns its own catalog entries.
 */
export interface RuntimeCapabilityNodeSpec {
  id: string;
  label: string;
  description: string;
  class: AutomationNodeDescriptor["class"];
  backingCapability: string;
  actionNames: string[];
  pluginNames: string[];
  ownerScoped: boolean;
  enabledWithoutRuntimeCapability: boolean;
  disabledReason: string;
}

function normalizeCapabilityName(value: string): string {
  return value.trim().toLowerCase();
}

function getRuntimeActionCapabilityNames(runtime: AgentRuntime): Set<string> {
  const names = new Set<string>();
  for (const action of runtime.actions ?? []) {
    names.add(normalizeCapabilityName(action.name));
    for (const simile of action.similes ?? []) {
      names.add(normalizeCapabilityName(simile));
    }
  }
  return names;
}

function getRuntimePluginNames(runtime: AgentRuntime): Set<string> {
  return new Set(
    (runtime.plugins ?? [])
      .map((plugin) => normalizeCapabilityName(plugin.name))
      .filter((name) => name.length > 0),
  );
}

function hasMatchingRuntimeCapability(
  spec: RuntimeCapabilityNodeSpec,
  actionNames: Set<string>,
  pluginNames: Set<string>,
): boolean {
  if (spec.enabledWithoutRuntimeCapability) {
    return true;
  }
  return (
    spec.actionNames.some((name) =>
      actionNames.has(normalizeCapabilityName(name)),
    ) ||
    spec.pluginNames.some((name) =>
      pluginNames.has(normalizeCapabilityName(name)),
    )
  );
}

/**
 * Build catalog descriptors for a set of runtime-capability specs, gating each
 * node's availability on the runtime's loaded actions/plugins.
 */
export function buildRuntimeCapabilityNodes(
  specs: RuntimeCapabilityNodeSpec[],
  runtime: AgentRuntime,
): AutomationNodeDescriptor[] {
  const actionNames = getRuntimeActionCapabilityNames(runtime);
  const pluginNames = getRuntimePluginNames(runtime);
  return specs.map((spec) => {
    const enabled = hasMatchingRuntimeCapability(
      spec,
      actionNames,
      pluginNames,
    );
    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      class: spec.class,
      source: "static_catalog",
      backingCapability: spec.backingCapability,
      ownerScoped: spec.ownerScoped,
      requiresSetup: !enabled,
      availability: enabled ? "enabled" : "disabled",
      ...(enabled ? {} : { disabledReason: spec.disabledReason }),
    };
  });
}

const contributors = new Map<string, AutomationNodeContributor>();

export function registerAutomationNodeContributor(
  id: string,
  contributor: AutomationNodeContributor,
): void {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Automation node contributor id is required");
  }
  contributors.set(normalizedId, contributor);
}

export function listAutomationNodeContributors(): AutomationNodeContributor[] {
  return [...contributors.values()];
}

export function clearAutomationNodeContributorsForTests(): void {
  contributors.clear();
}
