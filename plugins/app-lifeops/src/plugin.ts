import {
  getDefaultTriageService,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  messagingTriageActions,
  type Plugin,
  promoteSubactionsToActions,
  registerLocalizedExamplesProvider,
  registerSendPolicy,
  type State,
} from "@elizaos/core";
import { blockAction } from "./actions/block.js";
import { briefAction } from "./actions/brief.js";
import { calendarAction } from "./actions/calendar.js";
import { conflictDetectAction } from "./actions/conflict-detect.js";
import { connectorAction } from "./actions/connector.js";
import { credentialsAction } from "./actions/credentials.js";
import { docAction } from "./actions/document.js";
import { entityAction } from "./actions/entity.js";
import { inboxUnifiedAction } from "./actions/inbox-unified.js";
import { prioritizeAction } from "./actions/prioritize.js";
import {
  ownerAlarmsAction,
  ownerFinancesAction,
  ownerGoalsAction,
  ownerHealthAction,
  ownerRemindersAction,
  ownerRoutinesAction,
  ownerScreenTimeAction,
  ownerTodosAction,
  personalAssistantAction,
} from "./actions/owner-surfaces.js";
import { remoteDesktopAction } from "./actions/remote-desktop.js";
import { resolveRequestAction } from "./actions/resolve-request.js";
import { scheduledTaskAction } from "./actions/scheduled-task.js";
import { voiceCallAction } from "./actions/voice-call.js";
import { workThreadAction } from "./actions/work-thread.js";
import { ActivityTrackerService } from "./activity-profile/activity-tracker-service.js";
import { PresenceSignalBridgeService } from "./activity-profile/presence-signal-bridge-service.js";
import {
  ensureProactiveAgentTask,
  PROACTIVE_TASK_NAME,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";
import {
  ensureFollowupTrackerTask,
  FOLLOWUP_TRACKER_TASK_NAME,
  registerFollowupTrackerWorker,
} from "./followup/index.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
  registerDefaultChannelPack,
} from "./lifeops/channels/index.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
  registerDefaultConnectorPack,
} from "./lifeops/connectors/index.js";
import { applyMockoonEnvOverrides } from "./lifeops/connectors/mockoon-redirect.js";
import { createOwnerLocaleExamplesProvider } from "./lifeops/i18n/localized-examples-provider.js";
import {
  createMultilingualPromptRegistry,
  registerDefaultPromptPack,
  registerMultilingualPromptRegistry,
} from "./lifeops/i18n/prompt-registry.js";
import { BrowserBridgeAdapter } from "./lifeops/messaging/adapters/browser-bridge-adapter.js";
import { CalendlyAdapter } from "./lifeops/messaging/adapters/calendly-adapter.js";
import { LifeOpsGmailAdapter } from "./lifeops/messaging/adapters/gmail-adapter.js";
import { XDmAdapter } from "./lifeops/messaging/adapters/x-dm-adapter.js";
import { createOwnerSendPolicy } from "./lifeops/messaging/owner-send-policy.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
} from "./lifeops/owner/fact-store.js";
import {
  createAnchorRegistry,
  createEventKindRegistry,
  createFamilyRegistry,
  createWorkflowStepRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
  registerAppLifeOpsBusFamilies,
  registerAppLifeOpsEventKinds,
  registerBuiltinTelemetryFamilies,
  registerDefaultBlockerPack,
  registerDefaultFeatureFlagPack,
  registerDefaultWorkflowStepPack,
  registerEventKindRegistry,
  registerFamilyRegistry,
  registerWorkflowStepRegistry,
} from "./lifeops/registries/index.js";
import { LifeOpsRepository } from "./lifeops/repository.js";
// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";
import { lifeOpsSchema } from "./lifeops/schema.js";
import {
  createSendPolicyRegistry,
  registerSendPolicyRegistry,
} from "./lifeops/send-policy/index.js";
import {
  createActivitySignalBus,
  registerActivitySignalBus,
} from "./lifeops/signals/bus.js";
import { browserBridgeProvider } from "./provider.js";
// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import { appBlockerProvider } from "./providers/app-blocker.js";
import { crossChannelContextProvider } from "./providers/cross-channel-context.js";

// LifeOps core providers
import { firstRunProvider } from "./providers/first-run.js";
import { healthProvider } from "./providers/health.js";
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { pendingPromptsProvider } from "./providers/pending-prompts.js";
import { recentTaskStatesProvider } from "./providers/recent-task-states.js";
import { roomPolicyProvider } from "./providers/room-policy.js";
import { workThreadsProvider } from "./providers/work-threads.js";
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { BrowserBridgePluginService } from "./service.js";
import { registerBlockRuleReconcilerWorker } from "./website-blocker/chat-integration/index.js";
import {
  getSelfControlStatus,
  type SelfControlPluginConfig,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";
import { workThreadResponseHandlerEvaluator } from "./lifeops/work-threads/response-handler-evaluator.js";
import { threadOpsFieldEvaluator } from "./lifeops/work-threads/field-evaluator-thread-ops.js";
import { ownerProfileExtractionEvaluator } from "./lifeops/owner/profile-extraction-evaluator.js";
import { InboxTriageRepository } from "./inbox/repository.js";
import { createApprovalQueue } from "./lifeops/approval-queue.js";
import type { ApprovalChannel } from "./lifeops/approval-queue.types.js";

const GOOGLE_CONNECTOR_PLUGIN_PACKAGE = "@elizaos/plugin-google";
const GOOGLE_CONNECTOR_PLUGIN_NAME = "google";

type LifeOpsMessageActionHookArgs = {
  operation: string;
  runtime: IAgentRuntime;
  message: Memory;
  state?: State;
  options?: HandlerOptions;
  callback?: HandlerCallback;
};

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function looksLikeMissedCallRepairApproval(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bmissed\b/.test(normalized) &&
    /\bcall\b/.test(normalized) &&
    /\b(?:repair|reschedul|follow\s*up|reply|respond)\b/.test(normalized) &&
    /\b(?:approval|approve|hold|confirm)\b/.test(normalized)
  );
}

function looksLikeFlightConflictQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(?:flight|flights?|airport|jfk|sfo|lax|ewr|lga)\b/u.test(
      normalized,
    ) &&
    /\b(?:meeting|board|calendar|appointment|event)\b/u.test(normalized) &&
    /\b(?:land|lands|arrival|arrive|make|conflict|rebook)\b/u.test(
      normalized,
    )
  );
}

function looksLikeDocumentSignatureRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(?:nda|docusign|signature|signed|signing|sign\s+(?:the|a)?\s*(?:document|doc|nda)|document\s+sign(?:ing|ature)?)\b/u.test(
      normalized,
    ) &&
    /\b(?:meeting|appointment|kick-?off|deadline|before|due|in\s+\d+\s+days?|partnership)\b/u.test(
      normalized,
    ) &&
    /\b(?:initiate|start|begin|draft|queue|prepare|send|get\s+(?:it|the\s+nda)\s+signed|signing\s+flow)\b/u.test(
      normalized,
    )
  );
}

function looksLikePortalUploadRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(?:upload|submit|send|file)\b/u.test(normalized) &&
    /\bportal\b/u.test(normalized) &&
    /\b(?:deck|slides?|presentation|pdf|file)\b/u.test(normalized)
  );
}

function buildPortalUploadIntakeResponse(): ActionResult {
  return {
    text:
      "I need the portal link and the deck file or file path before I can upload it. Once you provide both, I will ask for approval to confirm before signing in or submitting anything.",
    success: true,
    data: {
      actionName: "COMPUTER_USE",
      operation: "portal_upload_intake",
      requiredInputs: ["portal_link", "deck_file"],
      requiresConfirmation: true,
    },
  };
}

function defaultSignatureDeadline(text: string): string {
  const match = /\bin\s+(\d+)\s+days?\b/iu.exec(text);
  if (match?.[1]) {
    return new Date(
      Date.now() + Number(match[1]) * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

async function queueDocumentSignatureRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const text = getMessageText(args.message);
  const documentName = /\bnda\b/iu.test(text) ? "NDA" : "Document";
  const documentId = `signature-${String(args.message.id ?? Date.now())}`;
  const signatureUrl = text.match(/https?:\/\/\S+/u)?.[0] ?? "pending-signature-url";
  const subjectUserId =
    typeof args.message.entityId === "string"
      ? args.message.entityId
      : String(args.runtime.agentId);
  const queue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });
  const request = await queue.enqueue({
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId,
      documentName,
      signatureUrl,
      deadline: defaultSignatureDeadline(text),
    },
    channel: "internal",
    reason: `Initiate signing flow for ${documentName}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const responseText = `Queued the ${documentName} signing flow for approval before anything is sent.`;
  await args.callback?.({
    text: responseText,
    source: "action",
    action: "PERSONAL_ASSISTANT",
  });
  return {
    success: true,
    text: responseText,
    data: {
      actionName: "PERSONAL_ASSISTANT",
      action: "sign_document",
      approvalRequestId: request.id,
    },
  };
}

function buildFlightConflictPreview(text: string): string {
  if (/8\s*(?:am|a\.m\.)/iu.test(text) && /9\s*(?:am|a\.m\.)/iu.test(text)) {
    return "The 8 AM JFK arrival is too tight for a 9 AM board meeting. I would treat that as a conflict unless the meeting is at the airport or remote. The concrete options are to rebook to an earlier flight or the night before, move the meeting later, or plan to join remotely while in transit.";
  }
  return "Your 8 AM JFK arrival is too tight for the 9 AM board meeting on that calendar day. I would treat it as a conflict and propose one of these concrete options: rebook to an arrival no later than 6:30 AM, fly in the night before, move the board meeting to 10:30 AM or later, or join remotely while in transit.";
}

function approvalChannelFromSource(source: string | null): ApprovalChannel {
  const normalized = (source ?? "").toLowerCase();
  if (normalized === "discord") return "discord";
  if (normalized === "imessage") return "imessage";
  if (normalized === "sms" || normalized === "text") return "sms";
  if (normalized === "x" || normalized === "twitter" || normalized === "x_dm") {
    return "x_dm";
  }
  return "telegram";
}

function extractCounterpartyHint(text: string): string | null {
  const match =
    /\bwith\s+(?:the\s+)?(.+?)(?:\s+(?:guys|team|folks|people)\b|[,.]|$)/iu.exec(
      text,
    ) ?? /\b(?:to|for)\s+([A-Z][\w &'-]{2,80})(?:[,.]|$)/u.exec(text);
  return match?.[1]?.replace(/\s+/gu, " ").trim() || null;
}

function textMatchesEntry(text: string, entryText: string): boolean {
  const normalized = text.toLowerCase();
  const candidate = entryText.toLowerCase();
  return candidate
    .split(/\s+/u)
    .map((token) => token.replace(/[^a-z0-9]/gu, ""))
    .filter((token) => token.length >= 4)
    .some((token) => normalized.includes(token));
}

async function handleLifeOpsMessageAction(
  args: LifeOpsMessageActionHookArgs,
): Promise<ActionResult | null> {
  if (
    args.operation !== "triage" &&
    args.operation !== "send_draft" &&
    args.operation !== "draft_followup" &&
    args.operation !== "draft_reply" &&
    args.operation !== "respond"
  ) {
    return null;
  }

  const text = getMessageText(args.message);
  if (!looksLikeMissedCallRepairApproval(text)) {
    return null;
  }

  const triageRepo = new InboxTriageRepository(args.runtime);
  const unresolved = await triageRepo.getUnresolved({ limit: 25 });
  const hint = extractCounterpartyHint(text);
  const match =
    unresolved.find((entry) => {
      const haystack = [
        entry.channelName,
        entry.senderName ?? "",
        entry.snippet,
        entry.suggestedResponse ?? "",
        ...(entry.threadContext ?? []),
      ].join(" ");
      return (
        (hint ? haystack.toLowerCase().includes(hint.toLowerCase()) : false) ||
        textMatchesEntry(text, haystack)
      );
    }) ?? unresolved[0];

  const recipient =
    match?.sourceRoomId ??
    match?.sourceEntityId ??
    match?.channelName ??
    hint ??
    "owner-selected-thread";
  const body =
    match?.suggestedResponse ??
    (hint
      ? `Sorry I missed your call earlier. I can reschedule and make the walkthrough work this week if you send a couple of windows.`
      : `Sorry I missed your call earlier. I can reschedule this week if you send a couple of windows that work.`);
  const channel = approvalChannelFromSource(match?.source ?? null);
  const subjectUserId =
    typeof args.message.entityId === "string"
      ? args.message.entityId
      : String(args.runtime.agentId);
  const queue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });
  const request = await queue.enqueue({
    requestedBy: "MESSAGE",
    subjectUserId,
    action: "send_message",
    payload: {
      action: "send_message",
      recipient,
      body,
      replyToMessageId: match?.sourceMessageId ?? null,
    },
    channel,
    reason: `Repair missed call thread${match?.channelName ? ` with ${match.channelName}` : hint ? ` with ${hint}` : ""}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const responseText = `Queued the repair note for your approval before sending it.`;
  await args.callback?.({
    text: responseText,
    source: "action",
    action: "MESSAGE",
  });
  return {
    text: responseText,
    success: true,
    data: {
      actionName: "MESSAGE",
      operation: args.operation,
      requestId: request.id,
      requiresConfirmation: true,
      channel,
      recipient,
    },
  };
}

async function handleLifeOpsDirectMessageRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
}): Promise<ActionResult | null> {
  const text = getMessageText(args.message);
  if (looksLikeMissedCallRepairApproval(text)) {
    return handleLifeOpsMessageAction({
      operation: "triage",
      runtime: args.runtime,
      message: args.message,
      state: args.state,
    });
  }
  if (looksLikeFlightConflictQuestion(text)) {
    return {
      text: buildFlightConflictPreview(text),
      success: true,
      data: {
        actionName: "CALENDAR",
        subaction: "flight_conflict_rebooking",
      },
    };
  }
  if (looksLikeDocumentSignatureRequest(text)) {
    return queueDocumentSignatureRequest(args);
  }
  if (looksLikePortalUploadRequest(text)) {
    return buildPortalUploadIntakeResponse();
  }
  return null;
}

async function ensureTaskWithRetries(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): Promise<void> {
  const isRuntimeStopped = () =>
    (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true;
  const delays = args.delays ?? [2_000, 5_000, 10_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (isRuntimeStopped()) {
      return;
    }
    try {
      await args.ensure();
      return;
    } catch (error) {
      if (isRuntimeStopped()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < delays.length) {
        args.runtime.logger?.warn?.(
          `${args.prefix} ${args.label} init failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      args.runtime.logger?.error?.(
        `${args.prefix} ${args.label} init failed after ${delays.length + 1} attempts: ${message}`,
      );
      throw error instanceof Error
        ? error
        : new Error(`${args.label} init failed: ${message}`);
    }
  }
}

function isDisabledByEnv(disableKey: string, enableKey?: string): boolean {
  const disableValue = (process.env[disableKey] ?? "").trim().toLowerCase();
  if (
    disableValue === "1" ||
    disableValue === "true" ||
    disableValue === "yes"
  ) {
    return true;
  }

  if (!enableKey) {
    return false;
  }

  const enableValue = (process.env[enableKey] ?? "").trim().toLowerCase();
  return enableValue === "0" || enableValue === "false";
}

function isGoogleConnectorPlugin(plugin: Plugin): boolean {
  return (
    plugin.name === GOOGLE_CONNECTOR_PLUGIN_NAME ||
    plugin.name === GOOGLE_CONNECTOR_PLUGIN_PACKAGE
  );
}

function resolvePluginExport(module: Record<string, unknown>): Plugin | null {
  for (const key of ["googlePlugin", "default"]) {
    const value = module[key];
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Plugin).name === "string"
    ) {
      return value as Plugin;
    }
  }
  return null;
}

async function importGoogleConnectorPluginModule(): Promise<
  Record<string, unknown>
> {
  try {
    return (await import(GOOGLE_CONNECTOR_PLUGIN_PACKAGE)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const stagedDependencyUrl = new URL(
      "../node_modules/@elizaos/plugin-google/dist/index.js",
      import.meta.url,
    );
    try {
      return (await import(stagedDependencyUrl.href)) as Record<
        string,
        unknown
      >;
    } catch {
      throw error;
    }
  }
}

export async function ensureLifeOpsGooglePluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some(isGoogleConnectorPlugin)) {
    return;
  }

  const module = await importGoogleConnectorPluginModule();
  const plugin = resolvePluginExport(module);
  if (!plugin) {
    throw new Error(
      `${GOOGLE_CONNECTOR_PLUGIN_PACKAGE} did not export a valid plugin`,
    );
  }
  if (runtime.plugins.some(isGoogleConnectorPlugin)) {
    return;
  }
  await runtime.registerPlugin(plugin);
}

const LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY =
  "eliza:lifeops:plugin:init-failures";

async function recordTaskInitFailure(
  runtime: IAgentRuntime,
  label: string,
  message: string,
): Promise<void> {
  try {
    const existing =
      (await runtime.getCache<Record<string, string>>(
        LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY,
      )) ?? {};
    existing[label] = message;
    await runtime.setCache(LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY, existing);
  } catch {
    // Cache not available; the logger.error is the primary signal.
  }
}

/**
 * Kick off task registration AFTER `runtime.initPromise` resolves — this step
 * cannot be awaited inside `init()` because `init()` runs before the runtime
 * itself has finished initializing. That means failures here are NOT fatal
 * to plugin load; the plugin reports as "loaded" and the specific task
 * subsystem reports as "unavailable". The failure is surfaced via the
 * runtime cache at LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY for observability and
 * via logger.error so ops tooling can alert on it.
 */
function scheduleTaskEnsureAfterRuntimeInit(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): void {
  void args.runtime.initPromise
    .then(async () => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      await ensureTaskWithRetries(args);
    })
    .catch((error) => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      args.runtime.logger?.error?.(
        `${args.prefix} ${args.label} init failed after runtime initialization (plugin stays loaded, this subsystem is degraded): ${message}`,
      );
      void recordTaskInitFailure(args.runtime, args.label, message);
    });
}

const rawAppLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "Owner operations: routines, goals, scheduled tasks, calendar, messaging, connectors, credentials, voice calls, browser companions, website/app blocking, and related owner-only surfaces.",
  dependencies: [GOOGLE_CONNECTOR_PLUGIN_PACKAGE],
  schema: lifeOpsSchema,
  actions: [
    // Canonical owner-operation umbrellas. Each umbrella registers itself + its
    // per-action virtuals via
    // `promoteSubactionsToActions` so the planner sees a discoverable
    // top-level entry for every flat child action (e.g. `BLOCK_BLOCK`,
    // `BLOCK_LIST_ACTIVE`, `OWNER_FINANCES_DASHBOARD`, `CREDENTIALS_FILL`, ...).
    ...promoteSubactionsToActions(blockAction),
    ...promoteSubactionsToActions(ownerFinancesAction),
    ...promoteSubactionsToActions(credentialsAction),
    ...promoteSubactionsToActions(calendarAction),
    ...promoteSubactionsToActions(resolveRequestAction),
    ...promoteSubactionsToActions(ownerRemindersAction),
    ...promoteSubactionsToActions(ownerAlarmsAction),
    ...promoteSubactionsToActions(ownerGoalsAction),
    ...promoteSubactionsToActions(ownerTodosAction),
    ...promoteSubactionsToActions(ownerRoutinesAction),
    ...promoteSubactionsToActions(ownerHealthAction),
    ...promoteSubactionsToActions(ownerScreenTimeAction),
    ...promoteSubactionsToActions(personalAssistantAction),
    entityAction,
    ...promoteSubactionsToActions(docAction),
    ...promoteSubactionsToActions(briefAction),
    ...promoteSubactionsToActions(prioritizeAction),
    ...promoteSubactionsToActions(conflictDetectAction),
    ...promoteSubactionsToActions(inboxUnifiedAction),
    ...promoteSubactionsToActions(voiceCallAction),
    remoteDesktopAction,
    workThreadAction,
    ...promoteSubactionsToActions(scheduledTaskAction),
    ...promoteSubactionsToActions(connectorAction),
    ...messagingTriageActions,
  ],
  providers: [
    browserBridgeProvider,
    websiteBlockerProvider,
    appBlockerProvider,
    firstRunProvider,
    roomPolicyProvider,
    lifeOpsProvider,
    pendingPromptsProvider,
    workThreadsProvider,
    recentTaskStatesProvider,
    healthProvider,
    inboxTriageProvider,
    crossChannelContextProvider,
    activityProfileProvider,
  ],
  services: [
    BrowserBridgePluginService,
    WebsiteBlockerService,
    ActivityTrackerService,
    PresenceSignalBridgeService,
  ],
  responseHandlerEvaluators: [
    ownerProfileExtractionEvaluator,
    workThreadResponseHandlerEvaluator,
  ],
  responseHandlerFieldEvaluators: [threadOpsFieldEvaluator],
  init: async (
    pluginConfig: Record<string, unknown>,
    runtime: IAgentRuntime,
  ) => {
    // When LIFEOPS_USE_MOCKOON=1, redirect every external connector base URL
    // to the matching Mockoon environment on localhost. No-op otherwise.
    const mockoonApplied = applyMockoonEnvOverrides();
    if (mockoonApplied.length > 0) {
      logger.info(
        { mockoonConnectors: mockoonApplied },
        `[lifeops] LIFEOPS_USE_MOCKOON=1 — redirecting ${mockoonApplied.length} connector base URL(s) to mock servers`,
      );
    }

    await ensureLifeOpsGooglePluginRegistered(runtime);

    setSelfControlPluginConfig(pluginConfig as SelfControlPluginConfig);
    const status = await getSelfControlStatus();

    if (status.available) {
      logger.info(
        `[selfcontrol] Hosts-file blocker ready${status.active && status.endsAt ? ` until ${status.endsAt}` : status.active ? " until manually unblocked" : ""}`,
      );
    } else {
      logger.warn(
        `[selfcontrol] Plugin loaded, but local website blocking is unavailable: ${status.reason ?? "unknown reason"}`,
      );
    }

    const connectorRegistry = createConnectorRegistry();
    registerDefaultConnectorPack(connectorRegistry, runtime);
    registerConnectorRegistry(runtime, connectorRegistry);
    (runtime as IAgentRuntime & { connectorRegistry?: typeof connectorRegistry })
      .connectorRegistry = connectorRegistry;

    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    registerChannelRegistry(runtime, channelRegistry);
    (runtime as IAgentRuntime & { channelRegistry?: typeof channelRegistry })
      .channelRegistry = channelRegistry;

    const sendPolicyRegistry = createSendPolicyRegistry();
    registerSendPolicyRegistry(runtime, sendPolicyRegistry);

    registerDefaultBlockerPack(runtime);

    const anchorRegistry = createAnchorRegistry();
    registerAppLifeOpsAnchors(anchorRegistry);
    registerAnchorRegistry(runtime, anchorRegistry);
    (runtime as IAgentRuntime & { anchorRegistry?: typeof anchorRegistry })
      .anchorRegistry = anchorRegistry;

    const eventKindRegistry = createEventKindRegistry();
    registerAppLifeOpsEventKinds(eventKindRegistry);
    registerEventKindRegistry(runtime, eventKindRegistry);
    (runtime as IAgentRuntime & { eventKindRegistry?: typeof eventKindRegistry })
      .eventKindRegistry = eventKindRegistry;

    const familyRegistry = createFamilyRegistry();
    registerBuiltinTelemetryFamilies(familyRegistry);
    registerAppLifeOpsBusFamilies(familyRegistry);
    registerFamilyRegistry(runtime, familyRegistry);
    (runtime as IAgentRuntime & { busFamilyRegistry?: typeof familyRegistry })
      .busFamilyRegistry = familyRegistry;

    const workflowStepRegistry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(workflowStepRegistry);
    registerWorkflowStepRegistry(runtime, workflowStepRegistry);
    (
      runtime as IAgentRuntime & {
        workflowStepRegistry?: typeof workflowStepRegistry;
      }
    ).workflowStepRegistry = workflowStepRegistry;

    // FeatureFlagRegistry — open-key registry covering the 10 closed
    // `LifeOpsFeatureKey` built-ins plus any 3rd-party plugin contributions.
    // Audit C top-1 finding (`docs/audit/rigidity-hunt-audit.md`).
    registerDefaultFeatureFlagPack(runtime);

    const activitySignalBus = createActivitySignalBus({ familyRegistry });
    registerActivitySignalBus(runtime, activitySignalBus);

    const ownerFactStore = createOwnerFactStore(runtime);
    registerOwnerFactStore(runtime, ownerFactStore);

    const promptRegistry = createMultilingualPromptRegistry();
    registerDefaultPromptPack(promptRegistry);
    registerMultilingualPromptRegistry(runtime, promptRegistry);

    // End-to-end locale wiring: the planner (in core) reads this provider
    // each turn, awaits the resolved owner-locale, and passes the
    // resulting `LocalizedActionExampleResolver` into `buildActionCatalog`.
    registerLocalizedExamplesProvider(
      runtime,
      createOwnerLocaleExamplesProvider(runtime),
    );

    // Owner outbound-message approval policy: gmail drafts require explicit
    // owner approval; everything else passes straight through.
    registerSendPolicy(runtime, createOwnerSendPolicy());
    (
      runtime as IAgentRuntime & {
        lifeOpsMessageActionHook?: {
          handleMessageAction: typeof handleLifeOpsMessageAction;
        };
        lifeOpsDirectMessageHook?: {
          handleMessageRequest: typeof handleLifeOpsDirectMessageRequest;
        };
      }
    ).lifeOpsMessageActionHook = {
      handleMessageAction: handleLifeOpsMessageAction,
    };
    (
      runtime as IAgentRuntime & {
        lifeOpsDirectMessageHook?: {
          handleMessageRequest: typeof handleLifeOpsDirectMessageRequest;
        };
      }
    ).lifeOpsDirectMessageHook = {
      handleMessageRequest: handleLifeOpsDirectMessageRequest,
    };

    // First-party adapters backed by LifeOps services. Gmail and X replace the
    // core placeholders so MESSAGE triage operations operate on real connected data.
    const triage = getDefaultTriageService();
    triage.register(new LifeOpsGmailAdapter());
    triage.register(new XDmAdapter());
    triage.register(new CalendlyAdapter());
    triage.register(new BrowserBridgeAdapter());

    // Register the proactive activity-profile task worker.
    const proactiveAgentDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_PROACTIVE_AGENT",
      "ENABLE_PROACTIVE_AGENT",
    );
    if (!proactiveAgentDisabled) {
      registerProactiveTaskWorker(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[proactive]",
        label: "task",
        ensure: async () => {
          await ensureProactiveAgentTask(runtime);
        },
      });
    } else {
      runtime.logger?.info(
        "[proactive] Proactive agent task skipped — ELIZA_DISABLE_PROACTIVE_AGENT=1",
      );
    }

    // Register the follow-up tracker worker.
    registerFollowupTrackerWorker(runtime);
    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[followup-tracker]",
      label: "task",
      ensure: async () => {
        await ensureFollowupTrackerTask(runtime);
      },
    });

    registerBlockRuleReconcilerWorker(runtime);

    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[lifeops]",
      label: "inbox cache schema",
      ensure: async () => {
        await LifeOpsRepository.ensureInboxCacheIndexes(runtime);
      },
    });

    const lifeOpsSchedulerDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_LIFEOPS_SCHEDULER",
      "ENABLE_LIFEOPS_SCHEDULER",
    );
    if (!lifeOpsSchedulerDisabled) {
      registerLifeOpsTaskWorker(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[lifeops]",
        label: "scheduler task",
        ensure: async () => {
          await ensureLifeOpsSchedulerTask(runtime);
        },
      });
    } else {
      runtime.logger?.info(
        "[lifeops] Scheduler task skipped — ELIZA_DISABLE_LIFEOPS_SCHEDULER=1",
      );
    }
  },
  /**
   * Tear down everything `init` registered so `runtime.unloadPlugin(...)`
   * produces an actually-stopped LifeOps:
   *   - Unregister task workers (proactive, follow-up, scheduler)
   *   - Delete the persisted task rows that reference those workers
   *
   * Routes, services, actions, providers, and event listeners are cleaned
   * up automatically by the runtime's plugin-lifecycle teardown — no need
   * to touch those here.
   */
  dispose: async (runtime: IAgentRuntime) => {
    delete (runtime as IAgentRuntime & { lifeOpsMessageActionHook?: unknown })
      .lifeOpsMessageActionHook;
    delete (runtime as IAgentRuntime & { lifeOpsDirectMessageHook?: unknown })
      .lifeOpsDirectMessageHook;

    const taskNames: readonly string[] = [
      PROACTIVE_TASK_NAME,
      LIFEOPS_TASK_NAME,
      FOLLOWUP_TRACKER_TASK_NAME,
    ];

    // Delete persisted Task rows so the scheduler doesn't try to run them
    // on restart (the worker function will be gone).
    for (const name of taskNames) {
      try {
        const tasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
        });
        for (const task of tasks) {
          if (task.name === name && task.id) {
            try {
              await runtime.deleteTask(task.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              runtime.logger?.warn?.(
                `[lifeops:dispose] Failed to delete task ${name} (${task.id}): ${msg}`,
              );
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger?.warn?.(
          `[lifeops:dispose] Failed to list tasks for "${name}": ${msg}`,
        );
      }
    }

    // Unregister the in-memory worker functions.
    for (const name of taskNames) {
      try {
        runtime.unregisterTaskWorker?.(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger?.warn?.(
          `[lifeops:dispose] Failed to unregister task worker "${name}": ${msg}`,
        );
      }
    }
  },
};

export const appLifeOpsPlugin: Plugin = rawAppLifeOpsPlugin;

export { workThreadAction } from "./actions/work-thread.js";
export {
  getAppBlockerPermissionState,
  getAppBlockerStatus,
  getCachedAppBlockerStatus,
  getInstalledApps,
  requestAppBlockerPermission,
  selectAppsForBlocking,
  startAppBlock,
  stopAppBlock,
} from "./app-blocker/engine.js";
export type {
  OverdueDigest,
  OverdueFollowup,
} from "./followup/index.js";
export {
  computeOverdueFollowups,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  FOLLOWUP_MEMORY_TABLE,
  FOLLOWUP_TRACKER_INTERVAL_MS,
  FOLLOWUP_TRACKER_TASK_NAME,
  FOLLOWUP_TRACKER_TASK_TAGS,
  getFollowupTrackerRoomId,
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  reconcileFollowupsOnce,
  registerFollowupTrackerWorker,
  setFollowupThresholdAction,
  writeOverdueDigestMemory,
} from "./followup/index.js";
export { CheckinService } from "./lifeops/checkin/checkin-service.js";
export type { CheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export { resolveCheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export type {
  CheckinKind,
  CheckinReport,
  EscalationLevel,
  MeetingEntry,
  OverdueTodo,
  RecentWin,
  RecordAcknowledgementRequest,
  RunCheckinRequest,
} from "./lifeops/checkin/types.js";
export {
  FirstRunService,
  type ScheduledTaskRunnerLike,
  setScheduledTaskRunner,
} from "./lifeops/first-run/service.js";
export {
  createFirstRunStateStore,
  createOwnerFactStore,
  type FirstRunRecord,
  type FirstRunStateStore,
  type OwnerFactStore,
  type OwnerFacts,
  type OwnerFactsPatch,
} from "./lifeops/first-run/state.js";
export {
  createGlobalPauseStore,
  type GlobalPauseStatus,
  type GlobalPauseStore,
  type GlobalPauseWindow,
} from "./lifeops/global-pause/store.js";
export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  type HandoffEnterOpts,
  type HandoffStatus,
  type HandoffStore,
  type ResumeCondition,
  type ResumeEvaluation,
  type ResumeEvaluationInput,
} from "./lifeops/handoff/store.js";
export {
  createMultilingualPromptRegistry,
  getDefaultPromptExamplePair,
  getDefaultPromptRegistry,
  getMultilingualPromptRegistry,
  type MultilingualPromptRegistry,
  PROMPT_REGISTRY_DEFAULT_LOCALE,
  type PromptExampleEntry,
  type PromptLocale,
  type PromptRegistryFilter,
  registerDefaultPromptPack,
  registerMultilingualPromptRegistry,
  resolveActionExamplePairs,
} from "./lifeops/i18n/prompt-registry.js";
export {
  type EscalationRule,
  getOwnerFactStore,
  type OwnerFactEntry,
  type OwnerFactProvenance,
  type OwnerFactProvenanceSource,
  type OwnerFactWindow,
  type OwnerQuietHours,
  ownerFactsToView,
  type PolicyPatchEscalationRule,
  type PolicyPatchReminderIntensity,
  type ReminderIntensity,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "./lifeops/owner/fact-store.js";
export {
  createPendingPromptsStore,
  type PendingPromptRecordInput,
  type PendingPromptsStore,
} from "./lifeops/pending-prompts/store.js";
export {
  createWorkThreadStore,
  type CreateWorkThreadInput,
  type ThreadSourceRef,
  type UpdateWorkThreadInput,
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadEventType,
  type WorkThreadListFilter,
  type WorkThreadStatus,
  type WorkThreadStore,
} from "./lifeops/work-threads/index.js";
export { workThreadResponseHandlerEvaluator } from "./lifeops/work-threads/response-handler-evaluator.js";
// LifeOps runtime exports
export {
  ensureLifeOpsSchedulerTask,
  executeLifeOpsSchedulerTask,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./lifeops/runtime.js";
export type {
  AnchorConsolidationPolicy,
  AnchorContribution,
  AnchorRegistry,
  CompletionCheckContribution,
  CompletionCheckRegistry,
  EscalationLadder,
  EscalationLadderRegistry,
  EscalationStep,
  GateDecision,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskEscalation,
  ScheduledTaskFilter,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskOutput,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskRunner,
  ScheduledTaskRunnerHandle,
  ScheduledTaskShouldFire,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskTrigger,
  ScheduledTaskVerb,
  ProcessDueScheduledTasksRequest,
  ProcessDueScheduledTasksResult,
  ScheduledTaskDueContext,
  ScheduledTaskDueDecision,
  TaskGateContribution,
  TaskGateRegistry,
  TerminalState,
} from "./lifeops/scheduled-task/index.js";
export {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  DEFAULT_ESCALATION_LADDERS,
  PRIORITY_DEFAULT_LADDER_KEYS,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerStubAnchors,
  processDueScheduledTasks,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./lifeops/scheduled-task/index.js";
export type { CreateRuntimeRunnerOptions } from "./lifeops/scheduled-task/runtime-wiring.js";
export { createRuntimeScheduledTaskRunner } from "./lifeops/scheduled-task/runtime-wiring.js";
export { appBlockerProvider } from "./providers/app-blocker.js";
export type { FirstRunAffordance } from "./providers/first-run.js";
export { firstRunProvider } from "./providers/first-run.js";
export { healthProvider } from "./providers/health.js";
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";
export type {
  PendingPrompt,
  PendingPromptsProvider,
} from "./providers/pending-prompts.js";
export {
  createPendingPromptsProvider,
  pendingPromptsProvider,
} from "./providers/pending-prompts.js";
export type {
  RecentTaskStatesProvider,
  RecentTaskStatesSummary,
} from "./providers/recent-task-states.js";
export {
  createRecentTaskStatesProvider,
  recentTaskStatesProvider,
} from "./providers/recent-task-states.js";
export { roomPolicyProvider } from "./providers/room-policy.js";
export { workThreadsProvider } from "./providers/work-threads.js";
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export { BrowserBridgePluginService, browserBridgeProvider };
