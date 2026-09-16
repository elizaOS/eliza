/** Selects and composes message response providers using the full authorized context and turn policy. */

import type {
  Action,
  AgentContext,
  IAgentRuntime,
  Memory,
  Provider,
  RoleGateRole,
  State,
} from "@elizaos/core";
import {
  CONTEXT_ROUTING_METADATA_KEY,
  filterProvidersByContextGate,
  isPageScopedRoutingContext,
  parseContextRoutingMetadata,
  satisfiesRoleGate,
} from "@elizaos/core";
import {
  isAmbientStage1Turn,
  messageExplicitlyAddressesAgent,
  resolveStage1SenderRole,
} from "./addressing.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";

export const CORE_RESPONSE_STATE_PROVIDERS = [
  "RUNTIME_MODEL_CONTEXT",
  "UI_CONTEXT",
  "ENTITIES",
  "RECENT_MESSAGES",
  "ATTACHMENTS",
  "PLATFORM_CHAT_CONTEXT",
  "PLATFORM_USER_CONTEXT",
  // FACTS is dynamic and would otherwise never run during response
  // composition. Stage 1 keeps it rendered so durable user facts
  // ("my dog's name is Jeff", "my car is named Bertha") persisted by the
  // facts-and-relationships stage can be recalled on a later turn — even a
  // simple-path turn after the source message has scrolled out of the
  // RECENT_MESSAGES window. Without this, stored facts are written but
  // never retrieved into the answer. FACTS is cacheStable:false /
  // cacheScope:"turn" and BM25-ranked against the current message, so its
  // rendered text varies per turn (like CURRENT_TIME); we accept that
  // prefix-cache churn and token cost as the price of cross-turn recall.
  "FACTS",
  // CURRENT_TIME is dynamic and would otherwise be filtered out before
  // reaching the response handler. The wall-clock time is a baseline
  // signal for nearly every routing decision (scheduling, freshness of
  // recent messages, "today/tomorrow" parsing), so it's always-on here.
  "CURRENT_TIME",
];

/**
 * Names of registered providers that opted into always-on Stage-1 response
 * state via `alwaysInResponseState`. Composed regardless of selected contexts,
 * so a plugin's dynamic provider reaches Stage 1 without core naming it.
 */
export function alwaysOnResponseStateProviderNames(
  runtime: IAgentRuntime,
  userRoles?: readonly RoleGateRole[],
): string[] {
  const providers = Array.isArray(runtime.providers)
    ? (runtime.providers as Provider[])
    : [];
  const names: string[] = [];
  for (const provider of providers) {
    const name = provider.name?.trim();
    if (
      provider.alwaysInResponseState &&
      name &&
      !provider.private &&
      satisfiesRoleGate(userRoles, provider.roleGate) &&
      satisfiesRoleGate(userRoles, provider.contextGate?.roleGate)
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Provider names that must NEVER be rendered as text blocks in the v5
 * ContextObject because they're already conveyed through another channel:
 *   - ACTIONS / PROVIDERS / ACTION_STATE: meta-listings — the planner sees
 *     actions as native function tools, so a parallel text block is
 *     duplicative and confusing.
 *   - CHARACTER: identity is already rendered via `staticPrefix.systemPrompt`
 *     (system + bio + role) and chat style directions via
 *     `staticPrefix.characterPrompt`, so the text-block CHARACTER provider
 *     would duplicate the same content.
 * RECENT_MESSAGES stays included because Stage 1 needs full prior dialogue
 * text when no structured `recentMessages` array is available from the
 * provider. Structured prior turns are additionally rendered by
 * `appendPriorDialogueEvents`.
 */
export const MODEL_CONTEXT_PROVIDER_EXCLUSIONS = [
  "ACTIONS",
  "ACTION_STATE",
  "CHARACTER",
  "PROVIDERS",
] as const;

export const MODEL_CONTEXT_PROVIDER_EXCLUSION_SET = new Set<string>(
  MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
);

export const AMBIENT_TURN_PROVIDER_EXCLUSIONS = ["RECENT_ERRORS"] as const;

export function ambientTurnProviderExclusions(
  runtime: IAgentRuntime,
  message: Memory,
): readonly string[] {
  return isAmbientStage1Turn(
    runtime,
    message,
    messageExplicitlyAddressesAgent(runtime, message),
  )
    ? AMBIENT_TURN_PROVIDER_EXCLUSIONS
    : [];
}

export function hasPageScopedRoutingMetadata(message: Memory): boolean {
  const metadataCandidates = [message.content?.metadata, message.metadata];
  for (const rawMetadata of metadataCandidates) {
    if (!rawMetadata || typeof rawMetadata !== "object") continue;
    const routing = parseContextRoutingMetadata(
      (rawMetadata as Record<string, unknown>)[CONTEXT_ROUTING_METADATA_KEY],
    );
    if (
      isPageScopedRoutingContext(routing.primaryContext) ||
      routing.secondaryContexts?.some(isPageScopedRoutingContext)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The first-party app attaches this renderer-owned metadata to chat and voice
 * turns. Realtime app voice has the same model-selected tool surface even
 * when its gateway has no current-view snapshot. These relevance hints never
 * bypass action authorization, and unresolved candidates keep the full surface.
 */
export function hasUiViewPlannerScope(message: Memory): boolean {
  const metadataCandidates = [message.content?.metadata, message.metadata];
  for (const rawMetadata of metadataCandidates) {
    if (!rawMetadata || typeof rawMetadata !== "object") continue;
    const metadata = rawMetadata as Record<string, unknown>;
    if (
      metadata.clientTransport === "realtime_voice" ||
      (typeof metadata.uiView === "string" && metadata.uiView.trim()) ||
      (typeof metadata.uiViewPath === "string" && metadata.uiViewPath.trim()) ||
      Array.isArray(metadata.uiViewCapabilities)
    ) {
      return true;
    }
  }
  return false;
}

export function uiViewActionNames(message: Memory): Set<string> {
  const actionNames = new Set<string>();
  const metadataCandidates = [message.content?.metadata, message.metadata];
  for (const rawMetadata of metadataCandidates) {
    if (!rawMetadata || typeof rawMetadata !== "object") continue;
    const rawNames = (rawMetadata as Record<string, unknown>).uiViewActionNames;
    if (!Array.isArray(rawNames)) continue;
    for (const rawName of rawNames) {
      if (typeof rawName !== "string") continue;
      const normalized = normalizeActionIdentifier(rawName);
      if (normalized) actionNames.add(normalized);
    }
  }
  return actionNames;
}

export function uiViewActionPriority(
  action: Action,
  selectedContexts: readonly AgentContext[] | undefined,
  viewActionNames: ReadonlySet<string>,
): number {
  const actionName = normalizeActionIdentifier(action.name);
  if (viewActionNames.has(actionName)) return 0;

  const focusedContexts = (selectedContexts ?? [])
    .map((context) => String(context).trim().toLowerCase())
    .filter(
      (context) =>
        context.length > 0 &&
        context !== "general" &&
        !isPageScopedRoutingContext(context),
    );
  if (focusedContexts.length === 0) return 2;

  const focused = new Set(focusedContexts);
  return (action.contexts ?? []).some((context) =>
    focused.has(String(context).trim().toLowerCase()),
  )
    ? 1
    : 2;
}

/**
 * The provider include list for Stage-1 response-state composition: the core
 * response providers plus always-on plugin providers. Exported for tests.
 */
export function stage1ResponseStateProviderNames(
  runtime: IAgentRuntime,
  message: Memory,
  userRoles?: readonly RoleGateRole[],
): string[] {
  const excluded = new Set(ambientTurnProviderExclusions(runtime, message));
  return [
    ...CORE_RESPONSE_STATE_PROVIDERS,
    ...alwaysOnResponseStateProviderNames(runtime, userRoles),
  ].filter((name) => !excluded.has(name));
}

export async function composeResponseState(
  runtime: IAgentRuntime,
  message: Memory,
  skipCache = false,
): Promise<State> {
  // Always-on is a context opt-in, never a role-gate bypass. Resolve only
  // when a registered always-on provider needs a role decision.
  const needsRole = runtime.providers?.some(
    (provider) =>
      provider.alwaysInResponseState &&
      (provider.roleGate || provider.contextGate?.roleGate),
  );
  const roles = needsRole
    ? [await resolveStage1SenderRole(runtime, message)]
    : undefined;
  const providers = stage1ResponseStateProviderNames(runtime, message, roles);
  if (hasPageScopedRoutingMetadata(message)) {
    return runtime.composeState(
      message,
      [...providers, "page-scoped-context"],
      true,
      skipCache,
    );
  }
  return runtime.composeState(message, providers, true, skipCache);
}

export function selectV5PlannerStateProviderNames(args: {
  runtime: IAgentRuntime;
  message: Memory;
  selectedContexts: readonly AgentContext[];
  userRoles: readonly RoleGateRole[];
}): string[] {
  const providerNames = new Set<string>(CORE_RESPONSE_STATE_PROVIDERS);

  const providers = Array.isArray(args.runtime.providers)
    ? (args.runtime.providers as Provider[])
    : [];
  // Always-on response-state providers opt in via `alwaysInResponseState` and
  // are composed regardless of the turn's selected contexts (like the core
  // FACTS / CURRENT_TIME signals) — so a plugin's dynamic provider can reach
  // Stage 1 without core naming it.
  for (const name of alwaysOnResponseStateProviderNames(
    args.runtime,
    args.userRoles,
  )) {
    providerNames.add(name);
  }
  // filterProvidersByContextGate honors the FULL declared contextGate
  // (anyOf/allOf/noneOf) plus the catalog fallback for undeclared providers —
  // the plain {contexts, roleGate} reduction dropped world-style gates (#13203).
  for (const provider of filterProvidersByContextGate(
    providers,
    args.selectedContexts,
    args.userRoles,
  )) {
    const name = provider.name?.trim();
    if (!name || provider.private) {
      continue;
    }
    if (MODEL_CONTEXT_PROVIDER_EXCLUSION_SET.has(name.toUpperCase())) {
      continue;
    }
    providerNames.add(name);
  }

  for (const excluded of ambientTurnProviderExclusions(
    args.runtime,
    args.message,
  )) {
    providerNames.delete(excluded);
  }
  return [...providerNames];
}
