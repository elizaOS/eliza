/**
 * Runtime wiring for the ScheduledTask spine.
 *
 * Bridges the runner's typed dependencies to the live `IAgentRuntime` /
 * `LifeOpsRepository`. Diagnostic providers below stand in until callers register
 * the production `OwnerFactStore`, `GlobalPauseStore`, `EntityStore`,
 * `RelationshipStore`, and connector / channel registries.
 */

import crypto from "node:crypto";
import { createLocalAgentBackup, getAgentEventService } from "@elizaos/agent";
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
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerFallbackAnchors,
  registerScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerDepsBundle,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import { getChannelRegistry } from "../channels/index.js";
import type { DispatchResult } from "../connectors/contract.js";
import { decideDispatchPolicy } from "../connectors/dispatch-policy.js";
import { resolveDefaultTimeZone } from "../defaults.js";
import { resolveGlobalPauseStore } from "../global-pause/store.js";
import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { LifeOpsRepository } from "../repository.js";
import { preferEffectiveMergedState } from "../schedule-state.js";
import { getSendPolicyRegistry } from "../send-policy/index.js";
import { getActivitySignalBus } from "../signals/bus.js";

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
    const view = ownerFactsToView(await store.read());
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
      const sampleCount = effective?.baseline?.sampleCount;
      if (typeof sampleCount === "number" && Number.isFinite(sampleCount)) {
        view.personalBaseline = {
          sampleCount,
          windowDays: effective?.baseline?.windowDays,
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

/**
 * Diagnostic stand-in for `SubjectStoreView` when no store was injected.
 * Same warn-once semantics as the activity-bus shim; `subject_updated`
 * completion-checks will report no-update until a real store is wired.
 */
function makeRuntimeSubjectStoreView(runtime: IAgentRuntime): SubjectStoreView {
  let warned = false;
  return {
    wasUpdatedSince(args) {
      const registered = getLifeOpsScheduledTaskSubjectStore(runtime);
      if (registered) {
        return registered.wasUpdatedSince(args);
      }
      if (!warned) {
        warned = true;
        logger.warn(
          {
            src: "lifeops:scheduled-task:runtime-wiring",
            agentId: runtime.agentId,
          },
          "SubjectStore not registered; subject_updated completion-checks will report no-update. Inject a SubjectStoreView via createRuntimeScheduledTaskRunner({ subjectStore }).",
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

const LOCAL_AGENT_BACKUP_OPERATION = "agent.localBackup";

function isLocalAgentBackupDispatch(
  record: ScheduledTaskDispatchRecord,
): boolean {
  return record.metadata?.systemOperation === LOCAL_AGENT_BACKUP_OPERATION;
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
      if (!channel?.send) {
        if (
          record.channelKey === "in_app" ||
          record.channelKey === "push" ||
          record.output?.destination === "in_app_card"
        ) {
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
                text: record.promptInstructions,
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
          const isUrgent = record.intensity === "urgent";
          const notifier = getNotifier(opts.runtime);
          if (notifier) {
            try {
              await notifier.notify({
                title: isUrgent ? "Approval needed" : "Reminder",
                body: record.promptInstructions,
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
          };
        }
        return applyDispatchPolicy({
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" is not connected for send.`,
        });
      }

      const payload = {
        target: normalizeChannelTarget(
          record.channelKey,
          record.output?.target ?? record.channelKey,
        ),
        message: record.promptInstructions,
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

      return applyDispatchPolicy(await channel.send(payload));
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
  const subjectStore: SubjectStoreView =
    opts.subjectStore ?? makeRuntimeSubjectStoreView(opts.runtime);

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
    hostCapabilities:
      opts.hostCapabilities ??
      (() =>
        getHostExecutionCapabilities(
          opts.runtime,
        ) as ReadonlySet<TaskExecutionProfile>),
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
