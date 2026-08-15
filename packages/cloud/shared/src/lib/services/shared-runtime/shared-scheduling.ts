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
  parseScheduledTaskRow,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTask,
  type ScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling/edge";

export class SharedReminderCutoverConflictError extends Error {
  constructor(readonly activeToken: string) {
    super("Shared reminders are already reserved by another Dedicated cutover");
    this.name = "SharedReminderCutoverConflictError";
  }
}

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

/**
 * Reserve every reminder that can still fire for one exact tier cutover. The
 * row-level marker is also checked by the scheduler's atomic fire claim, so a
 * cron tick and cutover cannot both take ownership of the same occurrence.
 */
export async function reserveSharedRemindersForCutover(input: {
  sourceAgentId: string;
  targetAgentId: string;
  token: string;
}): Promise<ScheduledTask[]> {
  const [{ dbWrite }, { sql }] = await Promise.all([
    import("../../../db/client"),
    import("drizzle-orm"),
  ]);
  await dbWrite.execute(sql`
    UPDATE app_scheduling.life_scheduled_tasks
       SET transfer_token = ${input.token},
           transfer_target_agent_id = ${input.targetAgentId},
           transfer_status = 'reserved',
           updated_at = ${new Date().toISOString()},
           version = version + 1
     WHERE agent_id = ${input.sourceAgentId}
       AND kind = 'reminder'
       AND (
         next_fire_at IS NOT NULL
         OR (state_json::jsonb ->> 'status') IN ('scheduled', 'fired', 'acknowledged')
       )
       AND transfer_status IS NULL
  `);
  const conflicting = extractRows(
    await dbWrite.execute(sql`
      SELECT transfer_token
        FROM app_scheduling.life_scheduled_tasks
       WHERE agent_id = ${input.sourceAgentId}
         AND transfer_status = 'reserved'
         AND transfer_token <> ${input.token}
       LIMIT 1
    `),
  );
  if (conflicting[0]) {
    throw new SharedReminderCutoverConflictError(String(conflicting[0].transfer_token));
  }
  const rows = extractRows(
    await dbWrite.execute(sql`
      SELECT *
       FROM app_scheduling.life_scheduled_tasks
       WHERE agent_id = ${input.sourceAgentId}
         AND transfer_status IN ('reserved', 'committed')
         AND transfer_token = ${input.token}
         AND transfer_target_agent_id = ${input.targetAgentId}
       ORDER BY created_at ASC, id ASC
    `),
  );
  return rows.map(parseScheduledTaskRow);
}

/**
 * Permanently retire the Shared copy after Dedicated confirms the exact task
 * set. Rows remain as an audit receipt but can never be selected or claimed by
 * the Cloudflare cron again.
 */
export async function commitSharedReminderCutover(input: {
  sourceAgentId: string;
  targetAgentId: string;
  token: string;
  expectedTaskCount: number;
}): Promise<void> {
  const [{ dbWrite }, { sql }] = await Promise.all([
    import("../../../db/client"),
    import("drizzle-orm"),
  ]);
  await dbWrite.execute(sql`
    UPDATE app_scheduling.life_scheduled_tasks
       SET transfer_status = 'committed',
           updated_at = ${new Date().toISOString()},
           version = version + 1
     WHERE agent_id = ${input.sourceAgentId}
       AND transfer_token = ${input.token}
       AND transfer_target_agent_id = ${input.targetAgentId}
       AND transfer_status = 'reserved'
  `);
  const rows = extractRows(
    await dbWrite.execute(sql`
      SELECT COUNT(*)::integer AS count
        FROM app_scheduling.life_scheduled_tasks
       WHERE agent_id = ${input.sourceAgentId}
         AND transfer_token = ${input.token}
         AND transfer_target_agent_id = ${input.targetAgentId}
         AND transfer_status = 'committed'
    `),
  );
  if (Number(rows[0]?.count ?? -1) !== input.expectedTaskCount) {
    throw new Error("Shared reminder cutover receipt count does not match the imported task set");
  }
}
