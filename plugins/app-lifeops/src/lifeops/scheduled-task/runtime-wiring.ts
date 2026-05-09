/**
 * Wave-1 runtime wiring for the ScheduledTask spine (W1-A).
 *
 * Bridges the runner's typed dependencies to the live `IAgentRuntime` /
 * `LifeOpsRepository`. Other Wave-1 agents replace the stub providers
 * here when their deliverables ship:
 *
 *   - W1-C → `OwnerFactStore` (we ship a minimal `OwnerFactsView`
 *     today that reads `LifeOpsOwnerProfile` if present).
 *   - W1-C → `GlobalPauseStore` (we ship a no-op `GlobalPauseView`).
 *   - W1-E → `EntityStore` / `RelationshipStore` (we ship a no-op
 *     `SubjectStoreView`).
 *   - W1-F → `ConnectorRegistry` / `ChannelRegistry` (the dispatcher
 *     here is a no-op — outbound landing is W1-F + W2-B's surface).
 *
 * The wiring is intentionally narrow — every stub is documented so the
 * integration replace is surgical.
 */

import type { IAgentRuntime } from "@elizaos/core";

import { LifeOpsRepository } from "../repository.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
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
      async upsert(task: ScheduledTask) {
        await repo.upsertScheduledTask(agentId, task);
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

/**
 * Stub `OwnerFactsView` provider. W1-C ships the production wrapper
 * around `LifeOpsOwnerProfile`; this stub returns an empty view so
 * gates that depend on owner facts no-op-allow.
 */
function defaultOwnerFactsProvider(): () => Promise<OwnerFactsView> {
  return async () => ({});
}

/**
 * Stub `GlobalPauseView`. W1-C ships the real `GlobalPauseStore`.
 */
const noopGlobalPause: GlobalPauseView = {
  async current() {
    return { active: false };
  },
};

/**
 * Stub `ActivitySignalBusView`. W1-B's `plugin-health` and W2 work
 * register real subscribers; without them, completion-checks that
 * depend on bus signals always return false.
 */
const noopActivityBus: ActivitySignalBusView = {
  hasSignalSince() {
    return false;
  },
};

/**
 * Stub `SubjectStoreView`. W1-E ships the production stores.
 */
const noopSubjectStore: SubjectStoreView = {
  wasUpdatedSince() {
    return false;
  },
};

export interface CreateRuntimeRunnerOptions {
  runtime: IAgentRuntime;
  agentId: string;
  /** Override the stub providers as agents wire up. */
  ownerFacts?: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause?: GlobalPauseView;
  activity?: ActivitySignalBusView;
  subjectStore?: SubjectStoreView;
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

  const anchors = createAnchorRegistry();
  registerStubAnchors(anchors);

  const consolidation = createConsolidationRegistry();

  return createScheduledTaskRunner({
    agentId: opts.agentId,
    store: stores.store,
    logStore: stores.logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: opts.ownerFacts ?? defaultOwnerFactsProvider(),
    globalPause: opts.globalPause ?? noopGlobalPause,
    activity: opts.activity ?? noopActivityBus,
    subjectStore: opts.subjectStore ?? noopSubjectStore,
  });
}
