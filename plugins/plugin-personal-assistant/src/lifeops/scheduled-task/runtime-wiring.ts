/**
 * Runtime wiring for the ScheduledTask spine.
 *
 * Bridges the runner's typed dependencies to the live `IAgentRuntime` /
 * `LifeOpsRepository`: DB-backed task/log stores, the production dispatcher,
 * owner facts, global pause, the LifeOps subject store, and the runtime
 * event → task-fire bridge. The activity-bus view keeps a warn-once
 * diagnostic stand-in until `registerActivitySignalBus` runs in plugin init.
 */

import crypto from "node:crypto";
import {
  createLocalAgentBackup,
  getAgentEventService,
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  resolveOwnerContactWithFallback,
  resolveOwnerEntityId,
} from "@elizaos/agent";
import { getHostExecutionCapabilities } from "@elizaos/app-core/services/task-host-capabilities";
import { type IAgentRuntime, logger, ServiceType } from "@elizaos/core";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskDispatcher,
  ScheduledTaskDispatchRecord,
  ScheduledTaskFilter,
  ScheduledTaskLogEntry,
  ScheduledTaskLogStore,
  SubjectStoreView,
  TaskExecutionProfile,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  getAnchorRegistry,
  getScheduledTaskRunner,
  installScheduledTaskEventBridge,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerFallbackAnchors,
  registerScheduledTaskRunnerDeps,
  renderFailureDispatchResult,
  renderScheduledDispatchMessage,
  renderScheduledDispatchTitle,
  type ScheduledTaskRunnerDepsBundle,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import { assembleMorningBrief } from "../../default-packs/morning-brief.js";
import { getChannelRegistry } from "../channels/index.js";
import type { DispatchResult } from "../connectors/contract.js";
import { decideDispatchPolicy } from "../connectors/dispatch-policy.js";
import { getConnectorRegistry } from "../connectors/registry.js";
import { resolveDefaultTimeZone } from "../defaults.js";
import { resolveGlobalPauseStore } from "../global-pause/store.js";
import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { getEventKindRegistry } from "../registries/event-kind-registry.js";
import { LifeOpsRepository } from "../repository.js";
import { preferEffectiveMergedState } from "../schedule-state.js";
import { getSendPolicyRegistry } from "../send-policy/index.js";
import { getActivitySignalBus } from "../signals/bus.js";
import {
  behaviouralBaselineFromProfile,
  readActivityProfile,
  registerActivityProfileGates,
} from "./activity-gates.js";
import { registerModelMomentCheckGate } from "./moment-judge.js";
import { createLifeOpsSubjectStoreView } from "./subject-store.js";

interface RepositoryBackedStores {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
}

const subjectStoresByRuntime = new WeakMap<IAgentRuntime, SubjectStoreView>();

export function registerLifeOpsScheduledTaskSubjectStore(
  runtime: IAgentRuntime,
  subjectStore: SubjectStoreView,
): void {
  subjectStoresByRuntime.set(runtime, subjectStore);
}

function getLifeOpsScheduledTaskSubjectStore(
  runtime: IAgentRuntime,
): SubjectStoreView | null {
  return subjectStoresByRuntime.get(runtime) ?? null;
}

/**
 * Default `SubjectStoreView` for runner deps: prefer a store registered via
 * `registerLifeOpsScheduledTaskSubjectStore` — resolved on every call, since
 * registration may happen after the deps are built — and otherwise fall back
 * to the production LifeOps-backed view (entities / relationships / work
 * threads).
 */
function makeRuntimeSubjectStoreView(
  runtime: IAgentRuntime,
  agentId: string,
): SubjectStoreView {
  const lifeOpsView = createLifeOpsSubjectStoreView(runtime, agentId);
  return {
    wasUpdatedSince(args) {
      const registered = getLifeOpsScheduledTaskSubjectStore(runtime);
      return (registered ?? lifeOpsView).wasUpdatedSince(args);
    },
  };
}

/**
 * Bind the in-memory facade to the LifeOpsRepository SQL methods. Each
 * call routes through the repository so the runner is DB-backed but
 * agnostic about the storage shape.
 */
function makeRepositoryBackedStores(
  runtime: IAgentRuntime,
  agentId: string,
): RepositoryBackedStores {
  const repo = new LifeOpsRepository(runtime);
  return {
    store: {
      async upsert(task: ScheduledTask, options) {
        await repo.upsertScheduledTask(agentId, task, {
          nextFireAtIso: options?.nextFireAtIso ?? null,
        });
      },
      async claimForFire({ taskId, firedAtIso, expected }) {
        return repo.claimScheduledTaskForFire(agentId, {
          taskId,
          firedAtIso,
          ...(expected ? { expected } : {}),
        });
      },
      async get(taskId: string) {
        return repo.getScheduledTask(agentId, taskId);
      },
      async findByIdempotencyKey(key: string) {
        return repo.getScheduledTaskByIdempotencyKey(agentId, key);
      },
      async list(filter?: ScheduledTaskFilter) {
        const status = filter?.status;
        const statusList = Array.isArray(status)
          ? status
          : status
            ? [status]
            : undefined;
        return repo.listScheduledTasks(agentId, {
          kind: filter?.kind,
          status: statusList,
          subjectKind: filter?.subject?.kind,
          subjectId: filter?.subject?.id,
          source: filter?.source,
          ownerVisibleOnly: filter?.ownerVisibleOnly,
        });
      },
      async delete(taskId: string) {
        await repo.deleteScheduledTask(agentId, taskId);
      },
    },
    logStore: {
      async append(entry: ScheduledTaskLogEntry) {
        await repo.appendScheduledTaskLog(entry);
      },
      async list(args) {
        return repo.listScheduledTaskLog({
          agentId,
          taskId: args.taskId,
          sinceIso: args.sinceIso,
          untilIso: args.untilIso,
          excludeRollups: args.excludeRollups,
          limit: args.limit,
        });
      },
      async rollupOlderThan(args) {
        return repo.rollupScheduledTaskLog({
          agentId,
          olderThanIso: args.olderThanIso,
        });
      },
    },
  };
}

function defaultOwnerFactsProvider(
  runtime: IAgentRuntime,
): () => Promise<OwnerFactsView> {
  return async () => {
    const store = resolveOwnerFactStore(runtime);
    // `new Date()` drives the derived `travelActive` — the view reflects
    // whether the owner is inside a booked/declared travel window at this
    // instant, which is exactly what the `during_travel` gate needs each tick.
    const view = ownerFactsToView(await store.read(), new Date());
    const timezone = view.timezone ?? resolveDefaultTimeZone();
    try {
      const repo = new LifeOpsRepository(runtime);
      const [local, cloud] = await Promise.all([
        repo.getScheduleMergedState(runtime.agentId, "local", timezone),
        repo.getScheduleMergedState(runtime.agentId, "cloud", timezone),
      ]);
      const effective = preferEffectiveMergedState({
        now: new Date(),
        local,
        cloud,
      });
      const healthSampleCount = effective?.baseline?.sampleCount;
      // Behavioural baseline from the observed rhythm (plan D.2.3). Feeds the
      // same personalBaseline surface so `personal_baseline_sufficient` fires
      // once EITHER a health baseline OR enough observed behaviour exists —
      // avoids starving persona packs that have no health baseline on day one.
      const behavioural = behaviouralBaselineFromProfile(
        await readActivityProfile(runtime),
      );
      const sampleCount = Math.max(
        typeof healthSampleCount === "number" &&
          Number.isFinite(healthSampleCount)
          ? healthSampleCount
          : 0,
        behavioural?.sampleCount ?? 0,
      );
      if (sampleCount > 0) {
        view.personalBaseline = {
          sampleCount,
          windowDays:
            effective?.baseline?.windowDays ?? behavioural?.windowDays,
        };
      }
    } catch (error) {
      logger.warn(
        {
          src: "lifeops:scheduled-task:runtime-wiring",
          agentId: runtime.agentId,
          error,
        },
        "Failed to project schedule baseline sample count into owner facts; baseline-dependent gates will deny until it is available.",
      );
    }
    return view;
  };
}

/**
 * Diagnostic stand-in for `ActivitySignalBusView` when no bus was registered
 * for this runtime. Logs once per runner construction so the missing wiring
 * is visible at boot; completion-checks depending on signals will return
 * `false` (their honest "no signal observed" state) but the operator sees
 * the warning and can wire `registerActivitySignalBus` in plugin init.
 */
function makeMissingActivityBusView(
  runtime: IAgentRuntime,
): ActivitySignalBusView {
  let warned = false;
  return {
    hasSignalSince() {
      if (!warned) {
        warned = true;
        logger.warn(
          {
            src: "lifeops:scheduled-task:runtime-wiring",
            agentId: runtime.agentId,
          },
          "ActivitySignalBus not registered; completion-checks depending on activity signals will report no-signal. Call registerActivitySignalBus during plugin init.",
        );
      }
      return false;
    },
  };
}

function normalizeChannelTarget(
  channelKey: string,
  target: string | undefined,
): string | undefined {
  if (!target) return undefined;
  const prefix = `${channelKey}:`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

interface NotificationEmitter {
  notify: (input: {
    title: string;
    body?: string;
    category?: string;
    priority?: string;
    source?: string;
    deepLink?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
}

function getNotifier(runtime: IAgentRuntime): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

function metadataString(
  metadata: ScheduledTaskDispatchRecord["metadata"],
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Compose the owner-facing message for one dispatch. `promptInstructions` is a
 * model prompt, never user-facing copy, so there are exactly two composition
 * paths and neither delivers it verbatim:
 *
 * - Tasks whose structural `metadata.delegatesAssemblyTo` names the morning
 *   check-in assembler get the assembled brief's `summaryText` (#14802) —
 *   real data (meetings, todos, wins) the render prompt alone cannot supply;
 *   CheckinService already composes that text through the model.
 * - Everything else renders through `renderScheduledDispatchMessage` (the
 *   CheckinService model seam): the instruction is the PROMPT, the model's
 *   output is what the owner sees. Render failure throws and the dispatcher
 *   translates it into a typed retryable failure — no raw-instruction
 *   fallback and no canned placeholder copy.
 */
async function composeOwnerFacingScheduledTaskText(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string> {
  const delegatesAssemblyTo = metadataString(
    record.metadata,
    "delegatesAssemblyTo",
  );

  if (delegatesAssemblyTo === "lifeops:checkin:morning") {
    try {
      const assembled = await assembleMorningBrief(runtime, {
        timezone: resolveDefaultTimeZone(),
        now: new Date(record.firedAtIso),
      });
      const summaryText = assembled.report.summaryText.trim();
      if (record.metadata) {
        record.metadata.checkinReportId = assembled.report.reportId;
        record.metadata.checkinKind = assembled.report.kind;
      }
      if (summaryText.length > 0) return summaryText;
      throw new Error("Morning check-in assembler returned empty summaryText");
    } catch (error) {
      // error-policy:J4 designed degrade — the scheduled check-in still
      // reaches the owner with an honest "couldn't assemble" message instead
      // of silently dropping the fire; the assembly failure is surfaced via
      // reportError for RECENT_ERRORS/escalation.
      runtime.reportError("lifeops:scheduled-task:owner-facing-copy", error, {
        agentId: runtime.agentId,
        taskId: record.taskId,
        firedAtIso: record.firedAtIso,
        delegatesAssemblyTo,
      });
      return "Your morning check-in is ready, but I couldn't assemble the full brief right now.";
    }
  }

  return renderScheduledDispatchMessage(runtime, record);
}

const LOCAL_AGENT_BACKUP_OPERATION = "agent.localBackup";
const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  boundary: "lifeops.owner_contacts",
  operation: "load_owner_contacts",
  message:
    "[lifeops] Failed to load owner contacts; using empty owner contacts config.",
} as const;

function isLocalAgentBackupDispatch(
  record: ScheduledTaskDispatchRecord,
): boolean {
  return record.metadata?.systemOperation === LOCAL_AGENT_BACKUP_OPERATION;
}

function targetNeedsOwnerResolution(
  channelKey: string,
  target: string | undefined,
): boolean {
  const normalized = normalizeChannelTarget(channelKey, target);
  return !normalized || normalized === channelKey;
}

async function resolveOwnerChannelTarget(
  runtime: IAgentRuntime,
  channelKey: string,
): Promise<string | null> {
  const ownerContacts = loadOwnerContactsConfig(
    LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT,
  );
  const hints = await loadOwnerContactRoutingHints(runtime, ownerContacts);
  const hint = hints[channelKey] ?? null;
  let contactResolution =
    resolveOwnerContactWithFallback({
      ownerContacts,
      source: hint?.source ?? channelKey,
      ownerEntityId: null,
    }) ??
    resolveOwnerContactWithFallback({
      ownerContacts,
      source: channelKey,
      ownerEntityId: null,
    });
  if (!contactResolution) {
    const ownerEntityId = await resolveOwnerEntityId(runtime);
    contactResolution =
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: hint?.source ?? channelKey,
        ownerEntityId,
      }) ??
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: channelKey,
        ownerEntityId,
      });
  }
  const contact =
    contactResolution?.contact ??
    (hint?.source ? ownerContacts[hint.source] : undefined) ??
    ownerContacts[channelKey];
  return (
    hint?.channelId ??
    contact?.channelId ??
    hint?.roomId ??
    contact?.roomId ??
    hint?.entityId ??
    contact?.entityId ??
    null
  );
}

async function resolveScheduledTaskChannelTarget(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string | null> {
  if (!targetNeedsOwnerResolution(record.channelKey, record.output?.target)) {
    return (
      normalizeChannelTarget(record.channelKey, record.output?.target) ?? null
    );
  }
  return resolveOwnerChannelTarget(runtime, record.channelKey);
}

function deniedDecisionToDispatchResult(
  decision: Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof getSendPolicyRegistry>>["evaluate"]
    >
  >,
): DispatchResult | null {
  if (decision.kind === "allow") return null;
  if (decision.kind === "deny") {
    return (
      decision.asDispatchResult ?? {
        ok: false,
        reason: "auth_expired",
        userActionable: decision.userActionable,
        message: decision.reason,
      }
    );
  }
  return {
    ok: false,
    reason: "auth_expired",
    userActionable: true,
    message: decision.reason ?? "Send requires approval.",
  };
}

/**
 * Apply the runner's dispatch fallback policy to a raw `DispatchResult` before
 * handing it back to the ScheduledTask runner. This is where
 * {@link decideDispatchPolicy} is actually exercised in production (it was
 * previously unit-tested but never wired to a live dispatch): for a
 * retry-class failure such as `rate_limited` that a connector reported WITHOUT
 * an explicit `retryAfterMinutes`, the policy supplies the default backoff so
 * the runner reschedules the same escalation step instead of treating it as a
 * hard failure. Non-retry decisions leave the result untouched — the runner
 * reads the spine-owned `ok` / `retryAfterMinutes` fields and routes the rest.
 */
function applyDispatchPolicy(result: DispatchResult): DispatchResult {
  if (result.ok) return result;
  const decision = decideDispatchPolicy(result, {
    // A dispatcher issues a single send attempt; ladder advancement and the
    // step-dependent advance / surface_degraded / fail decisions belong to the
    // runner, which owns the escalation cursor. Here we only consume the
    // step-independent retry decision to fill a missing backoff, so a
    // single-step context is the correct view.
    currentStepIndex: 0,
    totalSteps: 1,
  });
  if (decision.kind === "retry" && result.retryAfterMinutes === undefined) {
    return { ...result, retryAfterMinutes: decision.retryAfterMinutes };
  }
  return result;
}

export function createProductionScheduledTaskDispatcher(opts: {
  runtime: IAgentRuntime;
}): ScheduledTaskDispatcher {
  return {
    async dispatch(
      record: ScheduledTaskDispatchRecord,
    ): Promise<DispatchResult> {
      if (isLocalAgentBackupDispatch(record)) {
        const backup = await createLocalAgentBackup(
          opts.runtime,
          {} as Parameters<typeof createLocalAgentBackup>[1],
        );
        logger.info(
          {
            src: "lifeops:scheduled-task",
            agentId: opts.runtime.agentId,
            taskId: record.taskId,
            fileName: backup.fileName,
            stateSha256: backup.stateSha256,
            sizeBytes: backup.sizeBytes,
          },
          "[lifeops-scheduled-task] Local agent backup completed",
        );
        return {
          ok: true,
          messageId: `agent-backup:${backup.fileName}`,
        };
      }

      const registry = getChannelRegistry(opts.runtime);
      const channel = registry?.get(record.channelKey) ?? null;
      const hasInAppSurfaceFallback =
        record.channelKey === "in_app" ||
        record.channelKey === "push" ||
        record.output?.destination === "in_app_card";
      if (!channel?.send && !hasInAppSurfaceFallback) {
        return applyDispatchPolicy({
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" is not connected for send.`,
        });
      }

      // `promptInstructions` is a model prompt, never user-facing copy: every
      // user-visible surface below (assistant stream, notification body,
      // connector channel send) delivers the composed owner-facing message —
      // delegated assembly or the model's rendering. A composition failure is
      // a typed, retryable dispatch failure — there is deliberately no
      // raw-instruction fallback, because delivering instruction-voice text
      // verbatim to the owner was the bug this step exists to fix.
      let message: string;
      try {
        message = await composeOwnerFacingScheduledTaskText(
          opts.runtime,
          record,
        );
      } catch (error) {
        // error-policy:J1 boundary translation — dispatch outcomes are the
        // runner's typed contract; the failure also reaches RECENT_ERRORS and
        // owner escalation via reportError.
        opts.runtime.reportError(
          "lifeops:scheduled-task:dispatch-render",
          error,
          { taskId: record.taskId, channelKey: record.channelKey },
        );
        return renderFailureDispatchResult(error);
      }

      if (!channel?.send) {
        // Honest delivery accounting: an in_app dispatch "succeeded" only
        // if at least one real surface accepted the payload — the live
        // assistant event bus (transient stream) or the notification
        // service (durable inbox). Previously this branch returned
        // ok:true unconditionally, fabricating delivery on hosts where
        // both surfaces were absent, so nothing ever retried/escalated.
        let surfacesAccepted = 0;
        const eventService = getAgentEventService(opts.runtime) as {
          emit?: (event: {
            runId: string;
            stream: string;
            data: Record<string, unknown>;
            agentId?: string;
          }) => void;
        } | null;
        if (typeof eventService?.emit === "function") {
          eventService.emit({
            runId: crypto.randomUUID(),
            stream: "assistant",
            agentId: opts.runtime.agentId,
            data: {
              text: message,
              source: "lifeops-scheduled-task",
              taskId: record.taskId,
              firedAtIso: record.firedAtIso,
              channelKey: record.channelKey,
              target: normalizeChannelTarget(
                record.channelKey,
                record.output?.target,
              ),
              ...(record.intensity ? { intensity: record.intensity } : {}),
              ...(record.contextRequest
                ? { contextRequest: record.contextRequest }
                : {}),
            },
          });
          surfacesAccepted += 1;
        }
        const notifier = getNotifier(opts.runtime);
        if (notifier) {
          try {
            const title = await renderScheduledDispatchTitle(
              opts.runtime,
              record,
              message,
            );
            const isUrgent = record.intensity === "urgent";
            await notifier.notify({
              title,
              body: message,
              category: isUrgent ? "approval" : "reminder",
              priority: isUrgent ? "urgent" : "normal",
              source: "lifeops",
              groupKey: `lifeops:${record.taskId}`,
              deepLink: "/chat",
              data: {
                taskId: record.taskId,
                firedAtIso: record.firedAtIso,
                channelKey: record.channelKey,
              },
            });
            surfacesAccepted += 1;
          } catch (error) {
            // error-policy:J4 explicit user-facing degrade — the assistant
            // stream may still have accepted the same owner-facing message.
            opts.runtime.reportError(
              "lifeops:scheduled-task:notification-render",
              error,
              { taskId: record.taskId, channelKey: record.channelKey },
            );
            logger.warn(
              { src: "lifeops:scheduled-task", error },
              "Notification emit failed",
            );
          }
        }
        if (surfacesAccepted === 0) {
          return {
            ok: false,
            reason: "disconnected",
            userActionable: false,
            message:
              "No in-app surface (assistant event bus or notification service) accepted the payload.",
          };
        }
        return {
          ok: true,
          messageId: `in_app:${record.taskId}:${record.firedAtIso}`,
          channelKey: record.channelKey,
          target:
            normalizeChannelTarget(record.channelKey, record.output?.target) ??
            "in_app",
        };
      }

      const target = await resolveScheduledTaskChannelTarget(
        opts.runtime,
        record,
      );
      if (!target) {
        return applyDispatchPolicy({
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" has no resolvable owner target for scheduled task delivery.`,
        });
      }

      const payload = {
        target,
        message,
        metadata: {
          taskId: record.taskId,
          firedAtIso: record.firedAtIso,
          ...(record.intensity ? { intensity: record.intensity } : {}),
          ...(record.contextRequest
            ? { contextRequest: record.contextRequest }
            : {}),
          ...(record.consolidationBatchId
            ? { consolidationBatchId: record.consolidationBatchId }
            : {}),
        },
      };

      const sendPolicies = getSendPolicyRegistry(opts.runtime);
      const policyDecision = await sendPolicies?.evaluate({
        source: { kind: "channel", key: record.channelKey },
        capability: "send",
        payload,
        taskId: record.taskId,
      });
      if (policyDecision) {
        const denied = deniedDecisionToDispatchResult(policyDecision);
        if (denied) return applyDispatchPolicy(denied);
      }

      const result = await channel.send(payload);
      if (result.ok) {
        return applyDispatchPolicy({
          ...result,
          channelKey: record.channelKey,
          target,
        });
      }
      return applyDispatchPolicy(result);
    },
  };
}

function resolveRuntimeAnchorRegistry(runtime: IAgentRuntime) {
  const existing = getAnchorRegistry(runtime);
  if (existing) {
    registerFallbackAnchors(existing);
    return existing;
  }
  const registry = createAnchorRegistry();
  registerAppLifeOpsAnchors(registry);
  registerFallbackAnchors(registry);
  registerAnchorRegistry(runtime, registry);
  return registry;
}

export interface CreateRuntimeRunnerOptions {
  runtime: IAgentRuntime;
  agentId: string;
  /** Override the default runtime providers as agents wire up. */
  ownerFacts?: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause?: GlobalPauseView;
  activity?: ActivitySignalBusView;
  subjectStore?: SubjectStoreView;
  /**
   * Override the host-capability probe. The default reads
   * `getHostExecutionCapabilities(runtime)` from `@elizaos/app-core`,
   * which detects iOS BackgroundRunner / Android FGS / Node desktop. Tests
   * inject a fixed set to exercise substitution behavior.
   */
  hostCapabilities?: () => ReadonlySet<TaskExecutionProfile>;
  now?: () => Date;
}

/**
 * Build the production deps bundle PA injects into `@elizaos/plugin-scheduling`'s
 * runner host. This is the LifeOps-specific wiring — DB-backed store/log,
 * production dispatcher, owner-facts / channel-keys / host-capability probes,
 * and PA's anchor registry. The generic registries (gates, completion-checks,
 * ladders, consolidation) are built here too so the spine's runner host uses the
 * built-in set rather than rebuilding them.
 */
function buildLifeOpsRunnerDeps(
  opts: CreateRuntimeRunnerOptions,
): ScheduledTaskRunnerDepsBundle {
  const stores = makeRepositoryBackedStores(opts.runtime, opts.agentId);

  const gates = createTaskGateRegistry();
  // Register the real ActivityProfile-backed readers for circadian_state_in /
  // no_recent_user_message_in and the model moment judge for
  // model_moment_check BEFORE the built-ins. registerBuiltInGates is
  // first-wins, so these production readers take precedence over the generic
  // fallbacks (which stay resolvable when PA is absent, e.g. plugin-health
  // standalone tests).
  registerActivityProfileGates(opts.runtime, gates);
  registerModelMomentCheckGate(opts.runtime, gates);
  registerBuiltInGates(gates);

  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);

  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const anchors = resolveRuntimeAnchorRegistry(opts.runtime);

  const consolidation = createConsolidationRegistry();

  // Default the production providers from the runtime. Tests / harnesses can
  // still inject overrides via the options bag. The diagnostic shims warn-once
  // on missing wiring so silent always-allow / always-false defaults are gone.
  const globalPause: GlobalPauseView =
    opts.globalPause ?? resolveGlobalPauseStore(opts.runtime);
  const activity: ActivitySignalBusView =
    opts.activity ??
    getActivitySignalBus(opts.runtime) ??
    makeMissingActivityBusView(opts.runtime);
  // Production default: the real LifeOps-backed subject store (entities /
  // relationships / work threads). Kinds without a durable per-id store yet
  // (document / calendar_event / self) warn once inside the view. The
  // runtime-registered store is consulted per call, not snapshotted here:
  // runner deps are built during plugin init, before callers get a chance to
  // register (e.g. registerLifeOpsScheduledTaskSubjectStore in tests).
  const subjectStore: SubjectStoreView =
    opts.subjectStore ??
    makeRuntimeSubjectStoreView(opts.runtime, opts.agentId);

  return {
    store: stores.store,
    logStore: stores.logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: opts.ownerFacts ?? defaultOwnerFactsProvider(opts.runtime),
    globalPause,
    activity,
    subjectStore,
    channelKeys: () => {
      const registry = getChannelRegistry(opts.runtime);
      if (!registry) return new Set();
      return new Set(registry.list().map((c) => c.kind));
    },
    channelAvailable: async (channelKey: string) => {
      const channelRegistry = getChannelRegistry(opts.runtime);
      const channel = channelRegistry?.get(channelKey) ?? null;
      if (!channel) return false;
      if (!channel.connectorKind) return true;
      const connector = getConnectorRegistry(opts.runtime)?.get(
        channel.connectorKind,
      );
      if (!connector?.send) return false;
      try {
        const status = await connector.status();
        return status.state !== "disconnected";
      } catch {
        return false;
      }
    },
    hostCapabilities:
      opts.hostCapabilities ??
      (() => getHostExecutionCapabilities(opts.runtime)),
    dispatcher: createProductionScheduledTaskDispatcher({
      runtime: opts.runtime,
    }),
  };
}

export function createRuntimeScheduledTaskRunner(
  opts: CreateRuntimeRunnerOptions,
): ScheduledTaskRunnerHandle {
  const deps = buildLifeOpsRunnerDeps(opts);
  return createScheduledTaskRunner({
    agentId: opts.agentId,
    store: deps.store,
    logStore: deps.logStore,
    gates: deps.gates ?? createTaskGateRegistry(),
    completionChecks: deps.completionChecks ?? createCompletionCheckRegistry(),
    ladders: deps.ladders ?? createEscalationLadderRegistry(),
    anchors: deps.anchors ?? resolveRuntimeAnchorRegistry(opts.runtime),
    consolidation: deps.consolidation ?? createConsolidationRegistry(),
    ownerFacts: deps.ownerFacts,
    globalPause: deps.globalPause,
    activity: deps.activity,
    subjectStore: deps.subjectStore,
    ...(opts.now ? { now: opts.now } : {}),
    ...(deps.channelKeys ? { channelKeys: deps.channelKeys } : {}),
    ...(deps.hostCapabilities
      ? { hostCapabilities: deps.hostCapabilities }
      : {}),
    dispatcher: deps.dispatcher,
  });
}

/**
 * Register PA's production deps as the runner host's injected deps provider on
 * `@elizaos/plugin-scheduling`. Called during PA `init`. First-wins: the spine
 * keeps this provider once set, so PA rows land in `app_lifeops` via the
 * injected repository-backed store even though the runner service itself lives
 * in `@elizaos/plugin-scheduling`.
 */
export function registerLifeOpsScheduledTaskRunnerDeps(
  runtime: IAgentRuntime,
): void {
  registerScheduledTaskRunnerDeps(runtime, (rt, agentId) =>
    buildLifeOpsRunnerDeps({ runtime: rt, agentId }),
  );
}

/**
 * Subscribe every event kind in PA's `EventKindRegistry` to the spine's
 * event → task-fire bridge, so `runtime.emitEvent(eventKind, payload)` fires
 * the `{ kind: "event", eventKind }` scheduled tasks whose optional `filter`
 * subset-matches the payload. Without this install the `event` trigger kind
 * is schema-accepted but never fired by anything (`isScheduledTaskDue`
 * deliberately reports event tasks not-due — they are push-fired here).
 *
 * Called from PA `init` immediately after `registerEventKindRegistry`; the
 * registry missing is a wiring bug, not a fallback case. The runner resolves
 * lazily per emitted event through the cached `ScheduledTaskRunnerService`
 * host, never a stale handle. Returns the uninstall function.
 */
export function installLifeOpsScheduledTaskEventBridge(
  runtime: IAgentRuntime,
): () => void {
  const registry = getEventKindRegistry(runtime);
  if (!registry) {
    throw new Error(
      "[lifeops:scheduled-task:runtime-wiring] EventKindRegistry is not registered; call registerEventKindRegistry before installLifeOpsScheduledTaskEventBridge.",
    );
  }
  return installScheduledTaskEventBridge({
    runtime,
    eventKinds: registry.list().map((c) => c.eventKind),
    getRunner: () =>
      getScheduledTaskRunner(runtime, { agentId: String(runtime.agentId) }),
  });
}
