/** Adapts Cloud Hyperdrive/Postgres to the canonical edge scheduling runner. */

import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createScheduledTaskRunner,
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  createTaskGateRegistry,
  extractRows,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling/edge";

export async function executeSharedSchedulingSql(
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const [{ dbWrite }, { sql }] = await Promise.all([
    import("../../../db/client"),
    import("drizzle-orm"),
  ]);
  return extractRows(await dbWrite.execute(sql.raw(sqlText)));
}

export function createSharedScheduledTaskRunner(
  agentId: string,
  dispatcher: ScheduledTaskDispatcher,
) {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return createScheduledTaskRunner({
    agentId,
    store: createSchedulingSqlScheduledTaskStore({
      agentId,
      executeSql: executeSharedSchedulingSql,
    }),
    logStore: createSchedulingSqlScheduledTaskLogStore({
      agentId,
      executeSql: executeSharedSchedulingSql,
    }),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: async () => false },
    subjectStore: { wasUpdatedSince: async () => false },
    dispatcher,
    channelKeys: () => new Set(["current_dm"]),
    hostCapabilities: () => new Set(["notify-only"]),
  });
}
