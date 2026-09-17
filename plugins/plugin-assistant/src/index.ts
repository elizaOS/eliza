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
      await behavior.init?.(config, runtime);
    },
    async dispose(runtime) {
      disposeAssistantReasoning(runtime);
      runtime.messageService = null;
      await behavior.dispose?.(runtime);
    },
  };
}
export const assistantPlugin = createAssistantPlugin();
export default assistantPlugin;

export { generateMediaAction } from "./features/advanced-capabilities/actions/generateMedia.ts";
export {
  roleAction,
  updateRoleAction,
} from "./features/advanced-capabilities/actions/role.ts";
export {
  buildFactKeywordsForStorage,
  buildFactSearchText,
  factClaimsEquivalent,
  factLexicalSimilarity,
  factPolarityDiffers,
  readStoredFactKeywords,
} from "./features/advanced-capabilities/fact-keywords.ts";
export * from "./features/advanced-memory/index.ts";
export { createAdvancedPlanningPlugin } from "./features/advanced-planning/index.ts";
export {
  AUTONOMY_SERVICE_TYPE,
  AUTONOMY_TASK_NAME,
  AUTONOMY_TASK_TAGS,
  AutonomyService,
} from "./features/autonomy/index.ts";
export * from "./features/basic-capabilities/index.ts";
export * from "./features/credential-proxy/index.ts";
export * from "./features/documents/index.ts";
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
  resetMissingServiceWarning,
  resolveContactWeight,
  respondToMessageAction,
  scheduleDraftSendAction,
  scoreMessage,
  scoreMessages,
  searchMessagesAction,
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
// Feature-owned public API.
export * from "./runtime/builtin-field-evaluators.ts";
export {
  getMessageHandlerReply,
  type MessageHandlerRoute,
  parseMessageHandlerOutput,
  routeMessageHandlerOutput,
  SIMPLE_CONTEXT_ID,
  type V5MessageHandlerOutput,
} from "./runtime/message-handler.ts";
export { FAILED_TOOL_FALLBACK_MESSAGE } from "./runtime/planner-loop.ts";
export { renderActionResultsForModel } from "./runtime/planner-rendering.ts";
export * from "./runtime/sub-planner.ts";
export * from "./services/evaluator.ts";
export * from "./services/evaluator-priorities.ts";
export { canonicalEvaluatorMessages } from "./services/evaluator-transcript.ts";
export {
  CODING_DELEGATION_ACTION_TAGS,
  findCodingDelegationActionName,
  hasActionTags,
  LEGACY_CODING_DELEGATION_ACTION_NAMES,
  looksLikeBareLinkShare,
  normalizeActionIdentifier,
} from "./services/message/direct-action-heuristics.ts";
export * from "./services/message.ts";
export { RelationshipsService } from "./services/relationships.ts";
export * from "./services/relationships-graph-builder.ts";
export * from "./services/trajectories.ts";
export { serializeTrajectoryExport } from "./services/trajectory-export.ts";

export * from "./utils/prompt-batcher.ts";
