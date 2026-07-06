/**
 * Simulation harness that fires concrete scheduled-task primitives through the real
 * scheduled-task runner with an in-memory store, advancing a controllable clock and
 * recording dispatch results.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  ActivitySignalBusView,
  DispatchResult,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskDispatcher,
  ScheduledTaskDispatchRecord,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskLogStore,
  ScheduledTaskRunnerHandle,
  SubjectStoreView,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
} from "@elizaos/plugin-scheduling";
import { registerDefaultChannelPack } from "../../src/lifeops/channels/default-pack.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../../src/lifeops/channels/registry.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../../src/lifeops/connectors/registry.js";
import { createProductionScheduledTaskDispatcher } from "../../src/lifeops/scheduled-task/runtime-wiring.js";

export type LifeOpsScheduledPrimitive =
  | "goal"
  | "todo"
  | "message_triage"
  | "reminder"
  | "checkin"
  | "followup"
  | "recap"
  | "approval";

export interface LifeOpsDispatchLedgerEntry
  extends ScheduledTaskDispatchRecord {
  result: DispatchResult;
}

export interface LifeOpsSimulatedConnectorSend {
  connectorKind: string;
  channelKind: string;
  payload: unknown;
  result: DispatchResult;
}

export interface LifeOpsScheduledTaskSimulationOptions {
  initialIso?: string;
  useProductionConnectorDispatcher?: boolean;
  simulatedChannelKind?: string;
  simulatedConnectorKind?: string;
}

/**
 * Deterministic output of the harness's stubbed `useModel`: the production
 * dispatcher renders `promptInstructions` through the model before any
 * user-visible surface, so simulated connector sends carry exactly this text.
 */
export const SIMULATED_RENDERED_DISPATCH_MESSAGE =
  "Simulated model-rendered dispatch message.";

export interface LifeOpsScheduledTaskSimulationHarness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
  readonly dispatches: LifeOpsDispatchLedgerEntry[];
  readonly connectorSends: LifeOpsSimulatedConnectorSend[];
  /**
   * Prompts the production dispatcher's render step sent to the stubbed
   * model (empty unless `useProductionConnectorDispatcher` is set).
   */
  readonly modelPrompts: string[];
  nowIso(): string;
  setNow(iso: string): void;
  advanceMinutes(minutes: number): void;
  setDispatchResult(
    result:
      | DispatchResult
      | ((record: ScheduledTaskDispatchRecord) => DispatchResult),
  ): void;
  setActivity(bus: ActivitySignalBusView): void;
  setSubjectStore(store: SubjectStoreView): void;
  setOwnerFacts(facts: OwnerFactsView): void;
  setGlobalPause(view: GlobalPauseView): void;
  schedulePrimitive(
    primitive: LifeOpsScheduledPrimitive,
    overrides?: Partial<ScheduledTaskInput>,
  ): Promise<ScheduledTask>;
  firePrimitive(task: ScheduledTask): Promise<ScheduledTask>;
}

const PRIMITIVE_KIND: Record<LifeOpsScheduledPrimitive, ScheduledTaskKind> = {
  goal: "custom",
  todo: "custom",
  message_triage: "custom",
  reminder: "reminder",
  checkin: "checkin",
  followup: "followup",
  recap: "recap",
  approval: "approval",
};

function normalizeOptions(
  input: string | LifeOpsScheduledTaskSimulationOptions,
): Required<LifeOpsScheduledTaskSimulationOptions> {
  if (typeof input === "string") {
    return {
      initialIso: input,
      useProductionConnectorDispatcher: false,
      simulatedChannelKind: "discord",
      simulatedConnectorKind: "discord",
    };
  }
  return {
    initialIso: input.initialIso ?? "2026-07-01T12:00:00.000Z",
    useProductionConnectorDispatcher:
      input.useProductionConnectorDispatcher ?? false,
    simulatedChannelKind: input.simulatedChannelKind ?? "discord",
    simulatedConnectorKind: input.simulatedConnectorKind ?? "discord",
  };
}

export function createLifeOpsScheduledTaskSimulationHarness(
  options: string | LifeOpsScheduledTaskSimulationOptions = {},
): LifeOpsScheduledTaskSimulationHarness {
  const opts = normalizeOptions(options);
  let now = new Date(opts.initialIso);
  let ownerFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "07:00", end: "10:00" },
    eveningWindow: { start: "18:00", end: "21:00" },
  };
  let activity: ActivitySignalBusView = { hasSignalSince: () => false };
  let subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };
  let globalPause: GlobalPauseView = {
    current: async () => ({ active: false }),
  };
  let nextDispatchResult:
    | DispatchResult
    | ((record: ScheduledTaskDispatchRecord) => DispatchResult) = (record) => ({
    ok: true,
    messageId: `sim_${record.taskId}`,
  });

  const dispatches: LifeOpsDispatchLedgerEntry[] = [];
  const connectorSends: LifeOpsSimulatedConnectorSend[] = [];
  const modelPrompts: string[] = [];

  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  let counter = 0;
  let channelKeys: (() => ReadonlySet<string>) | undefined;
  let dispatcher: ScheduledTaskDispatcher = {
    async dispatch(record) {
      const result =
        typeof nextDispatchResult === "function"
          ? nextDispatchResult(record)
          : nextDispatchResult;
      dispatches.push({ ...record, result });
      return result;
    },
  };

  if (opts.useProductionConnectorDispatcher) {
    const runtime = {
      agentId: "pa-simulation-agent",
      getService: () => null,
      // Deterministic stand-in for the dispatcher's render step: capture the
      // prompt (so tests can assert instruction text only ever reaches the
      // model as opaque payload) and return a fixed rendered message.
      useModel: async (_type: string, params: { prompt: string }) => {
        modelPrompts.push(params.prompt);
        return SIMULATED_RENDERED_DISPATCH_MESSAGE;
      },
      reportError: () => undefined,
    } as unknown as IAgentRuntime;
    const connectorRegistry = createConnectorRegistry();
    connectorRegistry.register({
      kind: opts.simulatedConnectorKind,
      capabilities: ["send", `${opts.simulatedConnectorKind}.send`],
      modes: ["local"],
      describe: { label: `Simulated ${opts.simulatedConnectorKind}` },
      start: async () => {},
      disconnect: async () => {},
      verify: async () => true,
      status: async () => ({
        state: "ok",
        observedAt: new Date(now).toISOString(),
      }),
      send: async (payload) => {
        const payloadRecord =
          payload && typeof payload === "object"
            ? (payload as {
                message?: unknown;
                metadata?: { firedAtIso?: unknown; taskId?: unknown };
              })
            : {};
        const dispatchRecord: ScheduledTaskDispatchRecord = {
          taskId:
            typeof payloadRecord.metadata?.taskId === "string"
              ? payloadRecord.metadata.taskId
              : "unknown",
          firedAtIso:
            typeof payloadRecord.metadata?.firedAtIso === "string"
              ? payloadRecord.metadata.firedAtIso
              : now.toISOString(),
          channelKey: opts.simulatedChannelKind,
          promptInstructions:
            typeof payloadRecord.message === "string"
              ? payloadRecord.message
              : "",
          // `contextRequest` is required-but-nullable on the dispatch record;
          // the simulated connector receives an already-serialized payload and
          // has no context to reconstruct, so it is explicitly absent.
          contextRequest: undefined,
        };
        const result =
          typeof nextDispatchResult === "function"
            ? nextDispatchResult(dispatchRecord)
            : nextDispatchResult;
        connectorSends.push({
          connectorKind: opts.simulatedConnectorKind,
          channelKind: opts.simulatedChannelKind,
          payload,
          result,
        });
        return result;
      },
    });
    registerConnectorRegistry(runtime, connectorRegistry);

    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    registerChannelRegistry(runtime, channelRegistry);
    channelKeys = () =>
      new Set(channelRegistry.list().map((channel) => channel.kind));
    dispatcher = createProductionScheduledTaskDispatcher({ runtime });
  }

  const runner = createScheduledTaskRunner({
    agentId: "pa-simulation-agent",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ownerFacts,
    globalPause: { current: (nowDate) => globalPause.current(nowDate) },
    activity: { hasSignalSince: (...args) => activity.hasSignalSince(...args) },
    subjectStore: {
      wasUpdatedSince: (...args) => subjectStore.wasUpdatedSince(...args),
    },
    dispatcher,
    newTaskId: () => {
      counter += 1;
      return `pa_sim_${counter}`;
    },
    now: () => new Date(now),
    ...(channelKeys ? { channelKeys } : {}),
  });

  const harness: LifeOpsScheduledTaskSimulationHarness = {
    runner,
    logStore,
    dispatches,
    connectorSends,
    modelPrompts,
    nowIso: () => now.toISOString(),
    setNow: (iso) => {
      now = new Date(iso);
    },
    advanceMinutes: (minutes) => {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    setDispatchResult: (result) => {
      nextDispatchResult = result;
    },
    setActivity: (bus) => {
      activity = bus;
    },
    setSubjectStore: (storeView) => {
      subjectStore = storeView;
    },
    setOwnerFacts: (facts) => {
      ownerFacts = facts;
    },
    setGlobalPause: (view) => {
      globalPause = view;
    },
    schedulePrimitive: async (primitive, overrides = {}) =>
      runner.schedule({
        kind: PRIMITIVE_KIND[primitive],
        promptInstructions: `Simulated ${primitive} scheduled task`,
        trigger: { kind: "manual" },
        priority: primitive === "approval" ? "high" : "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "simulation",
        ownerVisible: true,
        ...overrides,
        metadata: {
          ...(overrides.metadata ?? {}),
          primitive,
        },
      }),
    firePrimitive: async (task) => runner.fire(task.taskId),
  };

  return harness;
}
