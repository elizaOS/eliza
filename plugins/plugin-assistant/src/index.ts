/** Assistant policy is explicitly composed by the Node host. */
import type { Plugin } from "@elizaos/core";
import { createAssistantBehavior } from "./features/basic-capabilities/index.ts";
import { registerCoreShouldRespondRiskHook } from "./features/trust/should-respond-risk-gate.ts";
import {
  disposeAssistantReasoning,
  installAssistantReasoning,
} from "./runtime/assistant-reasoning.ts";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "./runtime/builtin-field-evaluators.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "./runtime/default-contexts.ts";
import {
  PLANNER_CONTINUATION_TASK,
  registerPlannerContinuationWorker,
} from "./services/message/planner-continuation.ts";
import { DefaultMessageService } from "./services/message.ts";

export function createAssistantPlugin(): Plugin {
  const behavior = createAssistantBehavior();
  return {
    ...behavior,
    name: "assistant",
    description:
      "Conversational planning, response generation, memory and assistant capabilities.",
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    async init(config, runtime) {
      if (runtime.messageService)
        throw new Error("A message service is already registered");
      installAssistantReasoning(runtime);
      runtime.contexts.tryRegisterMany(DEFAULT_CONTEXT_DEFINITIONS);
      runtime.messageService = new DefaultMessageService();
      registerCoreShouldRespondRiskHook(runtime);
      // Registered once per runtime, after storage is ready: recovery reads the
      // persisted continuation tasks left by a previous process.
      void runtime.initPromise
        .then(() => registerPlannerContinuationWorker(runtime))
        .catch((error) =>
          runtime.reportError(
            "PlannerContinuation.registrationFailure",
            error,
            {
              agentId: runtime.agentId,
            },
          ),
        );
      await behavior.init?.(config, runtime);
    },
    async dispose(runtime) {
      disposeAssistantReasoning(runtime);
      runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
      runtime.messageService = null;
      await behavior.dispose?.(runtime);
    },
  };
}
export const assistantPlugin = createAssistantPlugin();
export default assistantPlugin;

export {
  type ContactActionDependencies,
  createContactActions,
} from "./actions/contact.ts";
export * from "./actions/context-signal.ts";
export * from "./actions/context-signal-lexicon.ts";
export * from "./actions/extract-params.ts";
export * from "./actions/grounded-action-reply.ts";
export {
  attachToChatAction,
  knowledgeActions,
  searchKnowledgeAction,
  sendMediaToAction,
} from "./actions/knowledge.ts";
export {
  ambiguousMemoryUserFacingText,
  inferMemorySubaction,
  MAX_MEMORY_ACTION_RESULT_CHARS,
  MAX_MEMORY_PAGE_ITEMS,
  memoryAction,
  memoryUserFacingLine,
} from "./actions/memories.ts";
export { notifyAction } from "./actions/notify.ts";
export * from "./entities.js";
export { generateMediaAction } from "./features/advanced-capabilities/actions/generateMedia.ts";
export { messageAction } from "./features/advanced-capabilities/actions/message.ts";
export { postAction } from "./features/advanced-capabilities/actions/post.ts";
export {
  roleAction,
  updateRoleAction,
} from "./features/advanced-capabilities/actions/role.ts";
export { roomOpAction } from "./features/advanced-capabilities/actions/room.ts";
export { reflectionItems } from "./features/advanced-capabilities/evaluators/reflection-items.ts";
export {
  getTaskCompletionCacheKey,
  type TaskCompletionAssessment,
} from "./features/advanced-capabilities/evaluators/task-completion.ts";
export {
  buildFactKeywordsForStorage,
  buildFactSearchText,
  factClaimsEquivalent,
  factLexicalSimilarity,
  factPolarityDiffers,
  readStoredFactKeywords,
} from "./features/advanced-capabilities/fact-keywords.ts";
export {
  advancedActions,
  advancedCapabilities,
  advancedEvaluators,
  advancedProviders,
  advancedServices,
} from "./features/advanced-capabilities/index.ts";
export { advancedContactsProvider } from "./features/advanced-capabilities/providers/contacts.ts";
export { factsProvider } from "./features/advanced-capabilities/providers/facts.ts";
export { followUpsProvider } from "./features/advanced-capabilities/providers/followUps.ts";
export { relationshipsProvider } from "./features/advanced-capabilities/providers/relationships.ts";
export { roleProvider } from "./features/advanced-capabilities/providers/roles.ts";
export { settingsProvider } from "./features/advanced-capabilities/providers/settings.ts";
export * from "./features/advanced-memory/index.ts";
export { createAdvancedPlanningPlugin } from "./features/advanced-planning/index.ts";
export {
  disableAutonomousModeAction,
  enableAutonomousModeAction,
  escalateAction,
} from "./features/autonomy/action.ts";
export {
  adminChatProvider,
  autonomyStatusProvider,
} from "./features/autonomy/providers.ts";
export { autonomyRoutes } from "./features/autonomy/routes.ts";
export {
  AUTONOMY_SERVICE_TYPE,
  AUTONOMY_TASK_NAME,
  AUTONOMY_TASK_TAGS,
  AutonomyService,
} from "./features/autonomy/service.ts";
export type {
  AutonomyConfig,
  AutonomyStatus,
} from "./features/autonomy/types.ts";
export { choiceAction } from "./features/basic-capabilities/actions/choice.ts";
export { ignoreAction } from "./features/basic-capabilities/actions/ignore.ts";
export { noneAction } from "./features/basic-capabilities/actions/none.ts";
export { replyAction } from "./features/basic-capabilities/actions/reply.ts";
export { linkExtractionEvaluator } from "./features/basic-capabilities/evaluators/link-extraction.ts";
export * from "./features/basic-capabilities/index.ts";
export { basicEvaluators as basicCapabilitiesEvaluators } from "./features/basic-capabilities/index.ts";
export { actionStateProvider } from "./features/basic-capabilities/providers/actionState.ts";
export { actionsProvider } from "./features/basic-capabilities/providers/actions.ts";
export { anxietyProvider } from "./features/basic-capabilities/providers/anxiety.ts";
export { attachmentsProvider } from "./features/basic-capabilities/providers/attachments.ts";
export { botAwarenessProvider } from "./features/basic-capabilities/providers/botAwareness.ts";
export { channelTopicsProvider } from "./features/basic-capabilities/providers/channelTopics.ts";
export { characterProvider } from "./features/basic-capabilities/providers/character.ts";
export { choiceProvider } from "./features/basic-capabilities/providers/choice.ts";
export {
  currentTimeProvider,
  resolveMessageTimeZone,
} from "./features/basic-capabilities/providers/currentTime.ts";
export { entitiesProvider } from "./features/basic-capabilities/providers/entities.ts";
export {
  PLATFORM_CHAT_CONTEXT_PROVIDER_NAME,
  PLATFORM_USER_CONTEXT_PROVIDER_NAME,
  platformChatContextProvider,
  platformUserContextProvider,
} from "./features/basic-capabilities/providers/platformContext.ts";
export { providersProvider } from "./features/basic-capabilities/providers/providers.ts";
export {
  dedupeHygienicDialogueMessages,
  isHygienicDialogueMessage,
  recentMessagesProvider,
} from "./features/basic-capabilities/providers/recentMessages.ts";
export { replyContextProvider } from "./features/basic-capabilities/providers/replyContext.ts";
export { runtimeModelContextProvider } from "./features/basic-capabilities/providers/runtimeModelContext.ts";
export { uiContextProvider } from "./features/basic-capabilities/providers/uiContext.ts";
export { userEmotionSignalProvider } from "./features/basic-capabilities/providers/userEmotionSignal.ts";
export { worldProvider } from "./features/basic-capabilities/providers/world.ts";
export * from "./features/credential-proxy/index.ts";
export * from "./features/documents/index.ts";
export {
  coreCapabilities,
  secretsCapability,
  trustCapability,
} from "./features/index.ts";
export type {
  DeferredMessageScheduleCommit,
  DeferredMessageScheduleRequest,
  DeferredMessageScheduleResult,
  DeferredMessageScheduler,
  DraftRecord,
  DraftRequest,
  ListOptions,
  ManageOperation,
  ManageResult,
  MessageAdapter,
  MessageAdapterCapabilities,
  MessageRef,
  MessageSource,
  ReadMessageControl,
  ReadMessageRequest,
  ReadMessageResult,
  ScoreContext,
  SearchMessagesFilters,
  SendConsentOptions,
  SendPolicy,
  TriageOptions,
  TriageScore,
} from "./features/messaging/triage/index.ts";
export {
  __resetDefaultMessageRefStoreForTests,
  __resetDefaultTriageServiceForTests,
  BaseMessageAdapter,
  draftFollowupAction,
  draftReplyAction,
  getDefaultMessageRefStore,
  getDefaultTriageService,
  getDeferredMessageScheduler,
  getSendPolicy,
  listInboxAction,
  MessageRefStore,
  manageMessageAction,
  messagingTriageActions,
  NotYetImplementedError,
  rankScored,
  registerDeferredMessageScheduler,
  registerSendPolicy,
  requireSendConsent,
  resetMissingServiceWarning,
  resolveContactWeight,
  respondToMessageAction,
  scheduleDraftSendAction,
  scoreMessage,
  scoreMessages,
  searchMessagesAction,
  sendConsentDigest,
  sendDraftAction,
  triageMessagesAction,
} from "./features/messaging/triage/index.ts";
export {
  CONNECTOR_NATIVE_OAUTH_PROVIDERS,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from "./features/oauth/types.ts";
export { paymentsPlugin } from "./features/payments/index.ts";
export {
  isSerializedSecretHandle,
  SECRETS_SERVICE_TYPE,
  type SecretsManagerPluginConfig,
  secretsManagerPlugin,
} from "./features/secrets/index.ts";
export * from "./features/sub-agent-credentials/index.ts";
export * from "./plugins/native-features.ts";
export { plannerTemplate } from "./prompts/planner.ts";
export * from "./runtime/action-catalog.js";
// Feature-owned public API.
export * from "./runtime/builtin-field-evaluators.ts";
export { visibleHistoryEventIds } from "./runtime/history-retention.ts";
export {
  getMessageHandlerReply,
  type MessageHandlerRoute,
  parseMessageHandlerOutput,
  routeMessageHandlerOutput,
  SIMPLE_CONTEXT_ID,
  type V5MessageHandlerOutput,
} from "./runtime/message-handler.ts";
export * from "./runtime/model-pricing";
export {
  FAILED_TOOL_FALLBACK_MESSAGE,
  runPlannerLoop,
} from "./runtime/planner-loop.ts";
export {
  projectToolResultForModel,
  renderActionResultsForModel,
} from "./runtime/planner-rendering.ts";
export {
  type ProviderOriginalMessages,
  renderProviderOriginalMessages,
} from "./runtime/provider-originals.ts";
export * from "./runtime/sub-planner.ts";
export * from "./runtime/trajectory-recorder";
export * from "./services/approval/index.ts";
export {
  DEVICE_VIEWS,
  DeviceActionError,
} from "./services/device-actions/contract.ts";
export {
  DeviceActionService,
  type DeviceCredential,
  deviceProposalDigest,
  withDeviceActionTurn,
} from "./services/device-actions/service.ts";
export * from "./services/evaluator.ts";
export * from "./services/evaluator-priorities.ts";
export { getEvaluatorProgressState } from "./services/evaluator-progress.ts";
export { canonicalEvaluatorMessages } from "./services/evaluator-transcript.ts";
export * from "./services/global-pause/index.ts";
export * from "./services/handoff/index.ts";
export {
  HISTORY_RETENTION_EVALUATOR,
  historyRetentionContext,
} from "./services/history-retention.ts";
export { priorDialogueOriginalText } from "./services/message/dialogue-context.ts";
export {
  CODING_DELEGATION_ACTION_TAGS,
  findCodingDelegationActionName,
  hasActionTags,
  LEGACY_CODING_DELEGATION_ACTION_NAMES,
  looksLikeBareLinkShare,
  normalizeActionIdentifier,
} from "./services/message/direct-action-heuristics.ts";
export * from "./services/message.ts";
export * from "./services/optimized-prompt.ts";
export { parseOptimizedPromptTargetBinding } from "./services/optimized-prompt-provenance.ts";
export * from "./services/pending-prompts/index.ts";
export {
  RELATIONSHIP_MERGE_CANDIDATE_NOT_FOUND,
  RelationshipsService,
} from "./services/relationships.ts";
export * from "./services/relationships-graph-builder.ts";
export * from "./services/trajectories.ts";
export { serializeTrajectoryExport } from "./services/trajectory-export.ts";
export * from "./utils/prompt-batcher.ts";
