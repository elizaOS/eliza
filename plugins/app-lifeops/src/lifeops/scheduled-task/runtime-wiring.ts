/**
 * Runtime wiring for the ScheduledTask spine.
 *
 * Bridges the runner's typed dependencies to the live `IAgentRuntime` /
 * `LifeOpsRepository`. Stub providers below stand in until callers register
 * the production `OwnerFactStore`, `GlobalPauseStore`, `EntityStore`,
 * `RelationshipStore`, and connector / channel registries.
 */

import crypto from "node:crypto";
import { getAgentEventService } from "@elizaos/agent";
import { type IAgentRuntime, logger } from "@elizaos/core";

import { getChannelRegistry } from "../channels/index.js";
import type { DispatchResult } from "../connectors/contract.js";
import { createGlobalPauseStore } from "../global-pause/store.js";
import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import {
  createAnchorRegistry,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "../registries/anchor-registry.js";
import { LifeOpsRepository } from "../repository.js";
import { getSendPolicyRegistry } from "../send-policy/index.js";
import { getActivitySignalBus } from "../signals/bus.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createConsolidationRegistry,
  registerStubAnchors,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type {
  ScheduledTaskDispatcher,
  ScheduledTaskDispatchRecord,
} from "./runner.js";
import {
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "./runner.js";
import type { ScheduledTaskLogStore } from "./state-log.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskFilter,
  ScheduledTaskLogEntry,
  SubjectStoreView,
} from "./types.js";

interface RepositoryBackedStores {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
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
      async claimForFire({ taskId, firedAtIso }) {
        return repo.claimScheduledTaskForFire(agentId, {
          taskId,
          firedAtIso,
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
    return ownerFactsToView(await store.read());
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
function makeMissingSubjectStoreView(runtime: IAgentRuntime): SubjectStoreView {
  let warned = false;
  return {
    wasUpdatedSince() {
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

export function createProductionScheduledTaskDispatcher(opts: {
  runtime: IAgentRuntime;
}): ScheduledTaskDispatcher {
  return {
    async dispatch(
      record: ScheduledTaskDispatchRecord,
    ): Promise<DispatchResult> {
      const registry = getChannelRegistry(opts.runtime);
      const channel = registry?.get(record.channelKey) ?? null;
      if (!channel?.send) {
        if (
          record.channelKey === "in_app" ||
          record.channelKey === "push" ||
          record.output?.destination === "in_app_card"
        ) {
          const eventService = getAgentEventService(opts.runtime) as {
            emit?: (event: {
              runId: string;
              stream: string;
              data: Record<string, unknown>;
              agentId?: string;
            }) => void;
          } | null;
          eventService?.emit?.({
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
          return {
            ok: true,
            messageId: `in_app:${record.taskId}:${record.firedAtIso}`,
          };
        }
        return {
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" is not connected for send.`,
        };
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
        if (denied) return denied;
      }

      return channel.send(payload);
    },
  };
}

function resolveRuntimeAnchorRegistry(runtime: IAgentRuntime) {
  const existing = getAnchorRegistry(runtime);
  if (existing) {
    registerStubAnchors(existing);
    return existing;
  }
  const registry = createAnchorRegistry();
  registerAppLifeOpsAnchors(registry);
  registerStubAnchors(registry);
  registerAnchorRegistry(runtime, registry);
  return registry;
}

export interface CreateRuntimeRunnerOptions {
  runtime: IAgentRuntime;
  agentId: string;
  /** Override the stub providers as agents wire up. */
  ownerFacts?: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause?: GlobalPauseView;
  activity?: ActivitySignalBusView;
  subjectStore?: SubjectStoreView;
  now?: () => Date;
}

export function createRuntimeScheduledTaskRunner(
  opts: CreateRuntimeRunnerOptions,
): ScheduledTaskRunnerHandle {
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
    opts.globalPause ?? createGlobalPauseStore(opts.runtime);
  const activity: ActivitySignalBusView =
    opts.activity ??
    getActivitySignalBus(opts.runtime) ??
    makeMissingActivityBusView(opts.runtime);
  const subjectStore: SubjectStoreView =
    opts.subjectStore ?? makeMissingSubjectStoreView(opts.runtime);

  return createScheduledTaskRunner({
    agentId: opts.agentId,
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
    now: opts.now,
    channelKeys: () => {
      const registry = getChannelRegistry(opts.runtime);
      if (!registry) return new Set();
      return new Set(registry.list().map((c) => c.kind));
    },
    dispatcher: createProductionScheduledTaskDispatcher({
      runtime: opts.runtime,
    }),
  });
}
