import {
  getDefaultTriageService,
  type IAgentRuntime,
  logger,
  messagingTriageActions,
  type Plugin,
  promoteSubactionsToActions,
  registerSendPolicy,
} from "@elizaos/core";
import { blockAction } from "./actions/block.js";
import { bookTravelAction } from "./actions/book-travel.js";
import { calendarAction } from "./actions/calendar.js";
import { connectorAction } from "./actions/connector.js";
import { credentialsAction } from "./actions/credentials.js";
import { deviceIntentAction } from "./actions/device-intent.js";
import { entityAction } from "./actions/entity.js";
import { firstRunAction } from "./actions/first-run.js";
import { healthAction } from "./actions/health.js";
import { calendlyAction } from "./actions/lib/calendly-handler.js";
import { lifeAction } from "./actions/life.js";
import { lifeOpsPauseAction } from "./actions/lifeops-pause.js";
import { messageHandoffAction } from "./actions/message-handoff.js";
import { moneyAction } from "./actions/money.js";
import { profileAction } from "./actions/profile.js";
import { remoteDesktopAction } from "./actions/remote-desktop.js";
import { resolveRequestAction } from "./actions/resolve-request.js";
import { scheduleAction } from "./actions/schedule.js";
import { scheduledTaskAction } from "./actions/scheduled-task.js";
import { schedulingNegotiationAction } from "./actions/scheduling-negotiation.js";
import { screenTimeAction } from "./actions/screen-time.js";
import { toggleFeatureAction } from "./actions/toggle-feature.js";
import { voiceCallAction } from "./actions/voice-call.js";
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
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { BrowserBridgePluginService } from "./service.js";
import { registerBlockRuleReconcilerWorker } from "./website-blocker/chat-integration/index.js";
import {
  getSelfControlStatus,
  type SelfControlPluginConfig,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";

const GOOGLE_CONNECTOR_PLUGIN_PACKAGE = "@elizaos/plugin-google";
const GOOGLE_CONNECTOR_PLUGIN_NAME = "google";

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
    "LifeOps: routines, goals, Google Workspace, Apple Reminders, Twilio, browser companions (Chrome/Safari), website blocking, app blocking, and related surfaces.",
  dependencies: [GOOGLE_CONNECTOR_PLUGIN_PACKAGE],
  schema: lifeOpsSchema,
  actions: [
    // Audit B umbrella folds (D-1, D-4, D-5): one umbrella per folded pair.
    // Each umbrella registers itself + its per-subaction virtuals via
    // `promoteSubactionsToActions` so the planner sees a discoverable
    // top-level entry for every flat subaction (e.g. `BLOCK_BLOCK`,
    // `BLOCK_LIST_ACTIVE`, `MONEY_DASHBOARD`, `CREDENTIALS_FILL`, …).
    ...promoteSubactionsToActions(blockAction),
    ...promoteSubactionsToActions(moneyAction),
    ...promoteSubactionsToActions(credentialsAction),
    ...promoteSubactionsToActions(calendarAction),
    calendlyAction,
    schedulingNegotiationAction,
    ...promoteSubactionsToActions(resolveRequestAction),
    deviceIntentAction,
    firstRunAction,
    ...promoteSubactionsToActions(lifeAction),
    lifeOpsPauseAction,
    messageHandoffAction,
    bookTravelAction,
    ...promoteSubactionsToActions(profileAction),
    entityAction,
    screenTimeAction,
    ...promoteSubactionsToActions(voiceCallAction),
    remoteDesktopAction,
    scheduleAction,
    ...promoteSubactionsToActions(scheduledTaskAction),
    healthAction,
    ...promoteSubactionsToActions(connectorAction),
    toggleFeatureAction,
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

    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    registerChannelRegistry(runtime, channelRegistry);

    const sendPolicyRegistry = createSendPolicyRegistry();
    registerSendPolicyRegistry(runtime, sendPolicyRegistry);

    registerDefaultBlockerPack(runtime);

    const anchorRegistry = createAnchorRegistry();
    registerAppLifeOpsAnchors(anchorRegistry);
    registerAnchorRegistry(runtime, anchorRegistry);

    const eventKindRegistry = createEventKindRegistry();
    registerAppLifeOpsEventKinds(eventKindRegistry);
    registerEventKindRegistry(runtime, eventKindRegistry);

    const familyRegistry = createFamilyRegistry();
    registerBuiltinTelemetryFamilies(familyRegistry);
    registerAppLifeOpsBusFamilies(familyRegistry);
    registerFamilyRegistry(runtime, familyRegistry);

    const workflowStepRegistry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(workflowStepRegistry);
    registerWorkflowStepRegistry(runtime, workflowStepRegistry);

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

    // Owner outbound-message approval policy: gmail drafts require explicit
    // owner approval; everything else passes straight through.
    registerSendPolicy(runtime, createOwnerSendPolicy());

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

export { firstRunAction } from "./actions/first-run.js";
export { lifeOpsPauseAction } from "./actions/lifeops-pause.js";
export { messageHandoffAction } from "./actions/message-handoff.js";
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
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export { BrowserBridgePluginService, browserBridgeProvider };
