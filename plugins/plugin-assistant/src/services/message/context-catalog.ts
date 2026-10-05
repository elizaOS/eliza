/** Renders complete routing catalogs and refreshes requested references for later
 * planning and completion. The provider event participates in normal replacement
 * on context restoration so revoked definitions are not retained. */
import type {
  ContextDefinition,
  ContextEvent,
  IAgentRuntime,
  Memory,
  RoleGateRole,
  State,
} from "@elizaos/core";
import {
  normalizeContextId,
  resolveProviderContextGate,
  satisfiesContextGate,
  satisfiesRoleGate,
} from "@elizaos/core";
import {
  actionDiscoveryContexts,
  collectV5PlannerCandidateActions,
} from "./action-surface.js";
import {
  listAvailableContextsForRole,
  resolveStage1SenderRole,
} from "./addressing.js";
import { MODEL_CONTEXT_PROVIDER_EXCLUSION_SET } from "./provider-state.js";

export const CONTEXT_CATALOG_REFERENCE = "CONTEXT_CATALOG";

/** Render authored routing hints without internal authorization/search metadata. */
export function formatAvailableContextsForPrompt(
  contexts: readonly ContextDefinition[],
): string {
  return contexts
    .map((definition) => {
      const description = (
        definition.descriptionCompressed ?? definition.description
      )?.trim();
      return description
        ? `- ${definition.id}: ${description}`
        : `- ${definition.id}`;
    })
    .join("\n");
}

/** Admit only domains backed by currently authorized actions or registered providers.
 * Capability validation never invokes action handlers. Complete definitions and
 * policy metadata remain in the registry; this projection only controls routing. */
export async function listAvailableContextsForTurn(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  role: RoleGateRole,
): Promise<ContextDefinition[]> {
  const definitions = listAvailableContextsForRole(runtime.contexts, role);
  const supported = new Set<string>(["simple"]);
  const permittedContexts = new Set(definitions.map(({ id }) => id));
  const actions = await collectV5PlannerCandidateActions({
    runtime,
    message,
    state,
    discoverActions: true,
    userRoles: [role],
  });
  for (const action of actions) {
    const gate = action.contextGate;
    const required = gate?.allOf ?? [];
    if (
      required.some(
        (context) => !permittedContexts.has(normalizeContextId(context)),
      )
    )
      continue;
    const declared = actionDiscoveryContexts(action);
    for (const context of declared.length ? declared : ["general"]) {
      const normalized = normalizeContextId(context);
      if (
        permittedContexts.has(normalized) &&
        satisfiesContextGate([normalized, ...required], gate, [role])
      )
        supported.add(normalized);
    }
  }
  for (const provider of runtime.providers ?? []) {
    if (
      provider.private ||
      MODEL_CONTEXT_PROVIDER_EXCLUSION_SET.has(provider.name.toUpperCase()) ||
      !satisfiesRoleGate([role], provider.roleGate) ||
      !satisfiesRoleGate([role], provider.contextGate?.roleGate)
    )
      continue;
    const gate = resolveProviderContextGate(provider);
    const required = gate.allOf ?? [];
    if (
      required.some(
        (context) => !permittedContexts.has(normalizeContextId(context)),
      )
    )
      continue;
    const declared = [
      ...(gate.contexts ?? []),
      ...(gate.anyOf ?? []),
      ...required,
    ];
    for (const context of declared.length ? declared : ["general"]) {
      const normalized = normalizeContextId(context);
      if (
        permittedContexts.has(normalized) &&
        satisfiesContextGate([normalized, ...required], gate, [role])
      ) {
        supported.add(normalized);
      }
    }
  }
  return definitions.filter(({ id }) => supported.has(id));
}

/** Use current authorization and registrations, never a prior model's catalog copy. */
export async function createContextCatalogReadEvent(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ContextEvent> {
  const role = await resolveStage1SenderRole(runtime, message);
  const catalog = formatAvailableContextsForPrompt(
    await listAvailableContextsForTurn(
      runtime,
      message,
      await runtime.composeState(message, [], true),
      role,
    ),
  );
  return {
    id: "context-catalog:loaded",
    type: "provider",
    source: "composeState",
    name: CONTEXT_CATALOG_REFERENCE,
    text: `context_loaded: ${CONTEXT_CATALOG_REFERENCE}\nAvailable routing contexts:\n${catalog}`,
    cacheStable: false,
  };
}
