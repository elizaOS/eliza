/** Renders complete message-handler instructions and model input with stable prompt-prefix boundaries. */
import {
  asUUID,
  ChannelType,
  type ChatMessage,
  COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
  type ContextDefinition,
  type ContextObject,
  completionContextSources,
  HANDLE_RESPONSE_TOOL_NAME,
  type IAgentRuntime,
  type Memory,
  normalizePromptSegments,
  type OptimizedPromptRuntimeLike,
  type PromptSegment,
  renderContextObject,
  resolveOptimizedPromptForRuntime,
  segmentBlock,
  selectHistoricalNavigation,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import { composePrompt } from "../../text/template-rendering.js";
import type { OptimizedPromptTask } from "../optimized-prompt.ts";
import { resolveStage1SenderRole } from "./addressing.js";
import {
  buildCurrentTurnBoundary,
  createV5MessageContextObject,
} from "./context-assembly.js";
import {
  CONTEXT_CATALOG_REFERENCE,
  formatAvailableContextsForPrompt,
  listAvailableContextsForTurn,
} from "./context-catalog.js";
import {
  type HistoryDiscovery,
  historyReferenceNotice,
  loadedHistorySegments,
  REVIEWED_HISTORY_SELECTION_INSTRUCTIONS,
} from "./history-discovery.js";
import {
  labelHistorySources,
  shortenHistoryRoleLabels,
} from "./history-wire.js";
import { messageHandlerTemplate } from "./prompts.js";
import {
  ambientTurnProviderExclusions,
  composeResponseState,
} from "./provider-state.js";
export const CODE_SNIPPET_VALIDITY_INSTRUCTION =
  "For code snippets, prioritize syntactically valid runnable code over impossible formatting constraints. If a tight line count would require invalid syntax, provide a valid version and briefly note the constraint tradeoff.";
export {
  CONTEXT_CATALOG_REFERENCE,
  formatAvailableContextsForPrompt,
} from "./context-catalog.js";
export interface ContextCatalogReference {
  text: string;
  notice: string;
  loaded: boolean;
}
/** Default direct-text routing can read the complete authorized catalog through
 * the same pre-effect context-request boundary as provider references. */
export function createContextCatalogReference(
  runtime: OptimizedPromptRuntimeLike,
  contexts: readonly ContextDefinition[],
): ContextCatalogReference | undefined {
  // Brief authored domain descriptions are cheap enough to supply directly.
  // Keep the compatibility entrypoint, without adding a routing-reference turn.
  void runtime;
  void contexts;
  return undefined;
}
export function formatRoleGateForPrompt(
  roleGate: ContextDefinition["roleGate"],
): string | undefined {
  if (!roleGate) {
    return undefined;
  }
  if (roleGate.minRole) {
    return `role>=${roleGate.minRole}`;
  }
  const anyOf = [...(roleGate.roles ?? []), ...(roleGate.anyOf ?? [])];
  if (anyOf.length > 0) {
    return `role=${anyOf.join("|")}`;
  }
  if (roleGate.allOf?.length) {
    return `role_all=${roleGate.allOf.join("+")}`;
  }
  return undefined;
}
/**
 * The Stage-1 `messageHandlerTemplate` covers two optimized-prompt tasks:
 *
 *   - `should_respond` — the prompt asks the model to decide whether to
 *     respond or ignore the message. Optimizing this task tunes the classifier.
 *   - `response` — Stage-1 also emits the assistant's draft reply when it
 *     decides to respond, so a separately-trained `response` artifact
 *     replaces the same baseline when present and the operator wants that
 *     variant active.
 */
export function selectMessageHandlerTask(
  _availableContexts: readonly ContextDefinition[],
): OptimizedPromptTask {
  // context_routing was retired (inferContextRoutingFromText is pure regex,
  // no LLM call to optimize); the message-handler template falls back to the
  // should_respond task for both the contexts-available and contexts-empty
  // callers.
  return "should_respond";
}
export function renderMessageHandlerInstructions(
  runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
  availableContexts: readonly ContextDefinition[],
  options?: {
    directMessage?: boolean;
    voiceDirectMessage?: boolean;
    nativeTools?: boolean;
    responseHandlerFields?: string;
    contextCatalog?: ContextCatalogReference;
  },
): string {
  const baseline = resolveOptimizedPromptForRuntime(
    runtime,
    selectMessageHandlerTask(availableContexts),
    messageHandlerTemplate,
  );
  const rendered = composePrompt({
    state: {
      agentName: runtime.character.name?.trim() || "the agent",
      directMessage: options?.directMessage ? "true" : "",
      availableContexts:
        options?.contextCatalog?.notice ??
        formatAvailableContextsForPrompt(availableContexts),
      handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
    },
    template: baseline,
  }).trim();
  if (options?.nativeTools || !options?.responseHandlerFields?.trim())
    return rendered;
  return [rendered, "# Response fields", options.responseHandlerFields].join(
    "\n\n",
  );
}
export function renderMessageHandlerModelInput(
  runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
  context: ContextObject,
  availableContexts: readonly ContextDefinition[] = [],
  options?: {
    directMessage?: boolean;
    voiceDirectMessage?: boolean;
    nativeTools?: boolean;
    groupTriage?: boolean;
    progressiveContext?: boolean;
    responseHandlerFields?: string;
    contextCatalog?: ContextCatalogReference;
    history?: HistoryDiscovery;
    historyReadEvidence?: HistoryDiscovery;
  },
): {
  messages: ChatMessage[];
  promptSegments: PromptSegment[];
} {
  const completionSources = completionContextSources(context);
  const completionSourceIds = new Map(
    completionSources?.sources.map(({ id, event }) => [event.id, id]),
  );
  const progressiveContextInput =
    options?.progressiveContext ??
    (options?.directMessage && !options.groupTriage);
  const history =
    progressiveContextInput &&
    options?.history?.sourceSetId === completionSources?.sourceSetId
      ? options?.history
      : undefined;
  const rendered = renderContextObject(
    history
      ? selectHistoricalNavigation(
          context,
          new Set([
            ...history.visibleEventIds,
            ...completionSources.sources
              .filter(({ id }) => history.loadedSourceIds.has(id))
              .map(({ event }) => event.id),
          ]),
        )
      : context,
  );
  const instructions = renderMessageHandlerInstructions(
    runtime,
    availableContexts,
    options,
  );
  const stableSegments = rendered.promptSegments.filter(
    (segment) => segment.stable,
  );
  const dynamicSegments = rendered.promptSegments.filter(
    (segment) => !segment.stable,
  );
  const currentTurnBoundary = dynamicSegments
    .filter((segment) => segment.id === "current-turn-boundary")
    .map((segment) =>
      history
        ? {
            ...segment,
            content: buildCurrentTurnBoundary({
              hasMemoryRecallSurface: false,
              hasOriginalReferences: true,
            }),
          }
        : segment,
    );
  const remainingDynamicSegments = dynamicSegments.filter(
    (segment) =>
      segment.id !== "current-turn-boundary" &&
      segment.id !== "available-actions",
  );
  const priorDialogueSegments = labelHistorySources(
    remainingDynamicSegments.filter(
      (segment) =>
        segment.label?.startsWith("prior_message:") === true &&
        (!history ||
          !segment.id ||
          !completionSourceIds.has(segment.id) ||
          history.visibleEventIds.has(segment.id)),
    ),
    completionSourceIds,
  );
  // Past effects remain complete historical evidence, before the instruction
  // that establishes the current request. They cannot become pending work by
  // being regrouped into the current turn's tool/result tail.
  const historicalNavigationSegments = remainingDynamicSegments.filter(
    (segment) =>
      segment.label === "runtime:historical_navigation" ||
      segment.label === "runtime:historical_navigation_scope",
  );
  const dynamicProviderSegments = remainingDynamicSegments.filter(
    (segment) => segment.label?.startsWith("provider:") === true,
  );
  const turnTailSegments = remainingDynamicSegments.filter(
    (segment) =>
      segment.label?.startsWith("prior_message:") !== true &&
      segment.label?.startsWith("provider:") !== true &&
      !historicalNavigationSegments.includes(segment),
  );
  // The boundary follows untrusted dialogue so stored messages cannot supersede
  // it with structural-looking text. Providers remain adjacent after that
  // boundary, preserving their reusable prefix before the current message.
  const orderedDynamicSegments = [
    ...(progressiveContextInput
      ? shortenHistoryRoleLabels(priorDialogueSegments, completionSourceIds)
      : priorDialogueSegments),
    ...historicalNavigationSegments,
    ...currentTurnBoundary,
    ...(completionSources?.sources.length
      ? [
          {
            content: `completion_source_set: ${completionSources.sourceSetId}\nThe [hN] labels above belong to this source set. Return completionContext according to history_source_selection.${historyReferenceNotice(context, history)}`,
            stable: false,
          },
        ]
      : []),
    ...dynamicProviderSegments,
    ...(options?.contextCatalog?.loaded
      ? [
          {
            id: "context-catalog-read",
            content: `context_loaded: ${CONTEXT_CATALOG_REFERENCE}\nThe complete requested reference follows; do not request it again.\n${options.contextCatalog.text}`,
            stable: false,
          },
        ]
      : []),
    ...loadedHistorySegments(
      context,
      history ??
        (progressiveContextInput ? options?.historyReadEvidence : undefined),
      history?.loadedSourceIds.size
        ? new Set(
            priorDialogueSegments.flatMap((segment) =>
              segment.id ? [segment.id] : [],
            ),
          )
        : undefined,
      Boolean(history),
    ),
    ...turnTailSegments,
  ];
  const stableWireSegments = [
    ...stableSegments,
    { content: instructions, stable: true },
    ...(completionSources?.sources.length
      ? [
          {
            content: history
              ? REVIEWED_HISTORY_SELECTION_INSTRUCTIONS
              : COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
            stable: true,
          },
        ]
      : []),
  ];
  const promptSegments = normalizePromptSegments([
    ...stableWireSegments,
    ...orderedDynamicSegments,
  ]);
  // `normalizePromptSegments` embeds separators in segment content for cache
  // consumers that concatenate the array. Render message blocks from the raw
  // segments so those separators remain between labeled blocks instead of
  // becoming extra whitespace inside a block's content.
  const systemContent = stableWireSegments.map(segmentBlock).join("\n\n");
  const userContent = orderedDynamicSegments.map(segmentBlock).join("\n\n");
  return {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    promptSegments,
  };
}
/**
 * Render only the *stable* part of the Stage-1 (`HANDLE_RESPONSE`) model
 * input for a given room — the system prompt + tool/action schema block +
 * the stable provider blocks. This is the prefix that does NOT depend on
 * the user's turn, so it is the exact text the local-inference KV cache
 * should be pre-warmed with the instant a voice session opens or VAD
 * detects speech onset (item I1/C1 of the voice swarm).
 *
 * The returned string is byte-identical to the `messages[0].content`
 * (the "system" message) that `renderMessageHandlerModelInput` would
 * produce for the first turn of a fresh conversation in that room — the
 * unstable tail (recent dialogue, the current user message) is dropped.
 * Pre-warming with this string lands the system prefix in the slot's KV
 * so the real request only forward-passes the user tokens.
 *
 * Best-effort by construction: composing state may hit providers that
 * query the DB; a synthetic empty message is used so a brand-new room
 * with no history still renders. Callers that fail to render should just
 * skip the pre-warm (the real request cold-prefills, which is the
 * pre-pre-warm behaviour).
 */
export async function renderMessageHandlerStablePrefix(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<string> {
  const syntheticMessage: Memory = {
    id: asUUID(v4()),
    entityId: (runtime.agentId ?? asUUID(v4())) as UUID,
    agentId: runtime.agentId,
    roomId,
    createdAt: Date.now(),
    content: {
      text: "",
      source: "voice-prewarm",
      channelType: ChannelType.VOICE_DM,
    },
  };
  const senderRole = await resolveStage1SenderRole(runtime, syntheticMessage);
  const state = await composeResponseState(runtime, syntheticMessage, true);
  const availableContexts = await listAvailableContextsForTurn(
    runtime,
    syntheticMessage,
    state,
    senderRole,
  );
  const context = await createV5MessageContextObject({
    runtime,
    message: syntheticMessage,
    state,
    userRoles: [senderRole],
    availableContexts,
    extraProviderExclusions: ambientTurnProviderExclusions(
      runtime,
      syntheticMessage,
    ),
    // Per-turn exclusions so the stable-prefix render is owned by the same
    // gate as every live render; the synthetic VOICE_DM message classifies
    // as addressed, so today this resolves to the static set.
  });
  const rendered = renderContextObject(context);
  const stableSegments = rendered.promptSegments.filter(
    (segment) => segment.stable,
  );
  const instructions = renderMessageHandlerInstructions(
    runtime,
    availableContexts,
    { directMessage: true },
  );
  return [...stableSegments, { content: instructions, stable: true }]
    .map(segmentBlock)
    .join("\n\n");
}
