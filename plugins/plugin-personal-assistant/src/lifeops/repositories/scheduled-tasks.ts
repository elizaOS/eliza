/** Adapts LifeOps scheduled tasks persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  executeRawSqlTx,
  OptimisticLockError,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toText,
} from "../sql.js";
import { isoNow } from "./record-values.js";
import {
  parseScheduledTaskLogRow,
  parseScheduledTaskRow,
} from "./scheduled-task-records.js";
export class ScheduledTaskRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertScheduledTask(
    agentId: string,
    task: import("@elizaos/plugin-scheduling").ScheduledTask,
    options?: {
      expectedVersion?: number;
      tx?: TransactionalDb;
      nextFireAtIso?: string | null;
    },
  ): Promise<void> {
    const now = isoNow();
    const expectedVersion = options?.expectedVersion;
    const tx = options?.tx;
    const nextFireAtSql =
      options?.nextFireAtIso === null ||
      options?.nextFireAtIso === undefined ||
      options.nextFireAtIso.length === 0
        ? "NULL"
        : `${sqlQuote(options.nextFireAtIso)}::timestamptz`;
    if (typeof expectedVersion === "number") {
      const updateSql = `UPDATE app_scheduling.life_scheduled_tasks
            SET kind = ${sqlQuote(task.kind)},
                prompt_instructions = ${sqlQuote(task.promptInstructions)},
                context_request_json = ${sqlText(task.contextRequest ? JSON.stringify(task.contextRequest) : null)},
                trigger_json = ${sqlJson(task.trigger)},
                priority = ${sqlQuote(task.priority)},
                should_fire_json = ${sqlText(task.shouldFire ? JSON.stringify(task.shouldFire) : null)},
                completion_check_json = ${sqlText(task.completionCheck ? JSON.stringify(task.completionCheck) : null)},
                escalation_json = ${sqlText(task.escalation ? JSON.stringify(task.escalation) : null)},
                output_json = ${sqlText(task.output ? JSON.stringify(task.output) : null)},
                pipeline_json = ${sqlText(task.pipeline ? JSON.stringify(task.pipeline) : null)},
                subject_kind = ${sqlText(task.subject?.kind ?? null)},
                subject_id = ${sqlText(task.subject?.id ?? null)},
                idempotency_key = ${sqlText(task.idempotencyKey ?? null)},
                respects_global_pause = ${sqlBoolean(task.respectsGlobalPause)},
                state_json = ${sqlJson(task.state)},
                source = ${sqlQuote(task.source)},
                created_by = ${sqlQuote(task.createdBy)},
                owner_visible = ${sqlBoolean(task.ownerVisible)},
                metadata_json = ${sqlJson(task.metadata ?? {})},
                execution_profile = ${sqlText(task.executionProfile ?? null)},
                next_fire_at = ${nextFireAtSql},
                updated_at = ${sqlQuote(now)},
                version = version + 1
          WHERE id = ${sqlQuote(task.taskId)}
            AND agent_id = ${sqlQuote(agentId)}
            AND version = ${sqlInteger(expectedVersion)}
        RETURNING id`;
      const rows = tx
        ? await executeRawSqlTx(tx, updateSql)
        : await executeRawSql(this.runtime, updateSql);
      if (rows.length === 0) {
        throw new OptimisticLockError({
          table: "life_scheduled_tasks",
          id: task.taskId,
          expectedVersion,
        });
      }
      return;
    }
    const upsertSql = `INSERT INTO app_scheduling.life_scheduled_tasks (
        id, agent_id, kind, prompt_instructions, context_request_json,
        trigger_json, priority, should_fire_json, completion_check_json,
        escalation_json, output_json, pipeline_json, subject_kind, subject_id,
        idempotency_key, respects_global_pause, state_json, source,
        created_by, owner_visible, metadata_json, execution_profile,
        next_fire_at, created_at, updated_at
      ) VALUES (
        ${sqlQuote(task.taskId)},
        ${sqlQuote(agentId)},
        ${sqlQuote(task.kind)},
        ${sqlQuote(task.promptInstructions)},
        ${sqlText(task.contextRequest ? JSON.stringify(task.contextRequest) : null)},
        ${sqlJson(task.trigger)},
        ${sqlQuote(task.priority)},
        ${sqlText(task.shouldFire ? JSON.stringify(task.shouldFire) : null)},
        ${sqlText(task.completionCheck ? JSON.stringify(task.completionCheck) : null)},
        ${sqlText(task.escalation ? JSON.stringify(task.escalation) : null)},
        ${sqlText(task.output ? JSON.stringify(task.output) : null)},
        ${sqlText(task.pipeline ? JSON.stringify(task.pipeline) : null)},
        ${sqlText(task.subject?.kind ?? null)},
        ${sqlText(task.subject?.id ?? null)},
        ${sqlText(task.idempotencyKey ?? null)},
        ${sqlBoolean(task.respectsGlobalPause)},
        ${sqlJson(task.state)},
        ${sqlQuote(task.source)},
        ${sqlQuote(task.createdBy)},
        ${sqlBoolean(task.ownerVisible)},
        ${sqlJson(task.metadata ?? {})},
        ${sqlText(task.executionProfile ?? null)},
        ${nextFireAtSql},
        ${sqlQuote(now)},
        ${sqlQuote(now)}
      )
      ON CONFLICT (agent_id, id) DO UPDATE SET
        kind = EXCLUDED.kind,
        prompt_instructions = EXCLUDED.prompt_instructions,
        context_request_json = EXCLUDED.context_request_json,
        trigger_json = EXCLUDED.trigger_json,
        priority = EXCLUDED.priority,
        should_fire_json = EXCLUDED.should_fire_json,
        completion_check_json = EXCLUDED.completion_check_json,
        escalation_json = EXCLUDED.escalation_json,
        output_json = EXCLUDED.output_json,
        pipeline_json = EXCLUDED.pipeline_json,
        subject_kind = EXCLUDED.subject_kind,
        subject_id = EXCLUDED.subject_id,
        idempotency_key = EXCLUDED.idempotency_key,
        respects_global_pause = EXCLUDED.respects_global_pause,
        state_json = EXCLUDED.state_json,
        source = EXCLUDED.source,
        created_by = EXCLUDED.created_by,
        owner_visible = EXCLUDED.owner_visible,
        metadata_json = EXCLUDED.metadata_json,
        execution_profile = EXCLUDED.execution_profile,
        next_fire_at = EXCLUDED.next_fire_at,
        updated_at = ${sqlQuote(now)}`;
    if (tx) {
      await executeRawSqlTx(tx, upsertSql);
    } else {
      await executeRawSql(this.runtime, upsertSql);
    }
  }

  async claimScheduledTaskForFire(
    agentId: string,
    args: {
      taskId: string;
      firedAtIso: string;
      expected?: import("@elizaos/plugin-scheduling").ScheduledTaskClaimExpectation;
    },
  ): Promise<
    | {
        kind: "fired";
        task: import("@elizaos/plugin-scheduling").ScheduledTask;
      }
    | { kind: "raced" }
  > {
    const now = isoNow();
    const expected = args.expected;
    const stateGuard = expected
      ? `AND (state_json::jsonb ->> 'status') = ${sqlQuote(expected.status)}
          AND ${
            expected.firedAtIso === null
              ? `(state_json::jsonb ->> 'firedAt') IS NULL`
              : `(state_json::jsonb ->> 'firedAt') = ${sqlQuote(expected.firedAtIso)}`
          }`
      : `AND (state_json::jsonb ->> 'status') = 'scheduled'`;
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_scheduling.life_scheduled_tasks
          SET state_json = jsonb_set(
                              jsonb_set(
                                state_json::jsonb,
                                '{status}',
                                '"fired"'::jsonb,
                                true
                              ),
                              '{firedAt}',
                              to_jsonb(${sqlQuote(args.firedAtIso)}::text),
                              true
                            )::text,
              next_fire_at = NULL,
              updated_at = ${sqlQuote(now)},
              version = version + 1
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(args.taskId)}
          ${stateGuard}
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) return { kind: "raced" };
    return { kind: "fired", task: parseScheduledTaskRow(row) };
  }

  async getScheduledTask(
    agentId: string,
    taskId: string,
  ): Promise<import("@elizaos/plugin-scheduling").ScheduledTask | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_scheduling.life_scheduled_tasks
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(taskId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseScheduledTaskRow(row) : null;
  }

  async getScheduledTaskByIdempotencyKey(
    agentId: string,
    idempotencyKey: string,
  ): Promise<import("@elizaos/plugin-scheduling").ScheduledTask | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_scheduling.life_scheduled_tasks
        WHERE agent_id = ${sqlQuote(agentId)}
          AND idempotency_key = ${sqlQuote(idempotencyKey)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseScheduledTaskRow(row) : null;
  }

  async listScheduledTasks(
    agentId: string,
    filter?: {
      kind?: string;
      status?: string | string[];
      subjectKind?: string;
      subjectId?: string;
      source?: string;
      ownerVisibleOnly?: boolean;
      /**
       * When set, the SELECT restricts to rows whose `next_fire_at <= value`
       * or whose `next_fire_at IS NULL` (the latter so event/manual/after_task
       * triggers — which deliberately have no wall-clock fire time but may
       * still need a tick pass for completion-timeout handling — remain
       * visible). The partial index `idx_life_scheduled_tasks_due` is used
       * when this filter is combined with a status list of
       * `('scheduled', 'fired')`.
       */
      dueAtOrBeforeIso?: string;
      /**
       * Restrict to rows with `next_fire_at IS NOT NULL`. Used by tests
       * that want to validate the index slice without the NULL escape hatch.
       */
      requireNextFireAt?: boolean;
    },
  ): Promise<import("@elizaos/plugin-scheduling").ScheduledTask[]> {
    const clauses: string[] = [`agent_id = ${sqlQuote(agentId)}`];
    if (filter?.kind) {
      clauses.push(`kind = ${sqlQuote(filter.kind)}`);
    }
    if (filter?.subjectKind) {
      clauses.push(`subject_kind = ${sqlQuote(filter.subjectKind)}`);
    }
    if (filter?.subjectId) {
      clauses.push(`subject_id = ${sqlQuote(filter.subjectId)}`);
    }
    if (filter?.source) {
      clauses.push(`source = ${sqlQuote(filter.source)}`);
    }
    if (filter?.ownerVisibleOnly) {
      clauses.push(`owner_visible = TRUE`);
    }
    if (filter?.status) {
      const arr = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      const inList = arr
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => sqlQuote(s))
        .join(", ");
      if (inList.length > 0) {
        // status is stored inside state_json — we filter post-fetch
        // but include the full row in case the caller wants it.
        clauses.push(`(state_json::jsonb ->> 'status') IN (${inList})`);
      }
    }
    if (typeof filter?.dueAtOrBeforeIso === "string") {
      const at = sqlQuote(filter.dueAtOrBeforeIso);
      clauses.push(
        `(next_fire_at IS NULL OR next_fire_at <= ${at}::timestamptz)`,
      );
    }
    if (filter?.requireNextFireAt === true) {
      clauses.push(`next_fire_at IS NOT NULL`);
    }
    const where = clauses.join(" AND ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_scheduling.life_scheduled_tasks
        WHERE ${where}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseScheduledTaskRow);
  }

  async deleteScheduledTask(agentId: string, taskId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_scheduling.life_scheduled_tasks
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(taskId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_scheduling.life_scheduled_task_log
        WHERE agent_id = ${sqlQuote(agentId)}
          AND task_id = ${sqlQuote(taskId)}`,
    );
  }

  async resetSchedulingStateForScenario(agentId: string): Promise<void> {
    const quotedAgent = sqlQuote(agentId);
    for (const statement of [
      `DELETE FROM app_scheduling.life_scheduled_tasks WHERE agent_id = ${quotedAgent}`,
      `DELETE FROM app_scheduling.life_scheduled_task_log WHERE agent_id = ${quotedAgent}`,
      `DELETE FROM app_lifeops.life_schedule_merged_states WHERE agent_id = ${quotedAgent}`,
      `DELETE FROM app_lifeops.life_schedule_insights WHERE agent_id = ${quotedAgent}`,
      `DELETE FROM app_lifeops.life_schedule_observations WHERE agent_id = ${quotedAgent}`,
      `DELETE FROM app_lifeops.life_circadian_states WHERE agent_id = ${quotedAgent}`,
    ]) {
      await executeRawSql(this.runtime, statement);
    }
  }

  async appendScheduledTaskLog(
    entry: import("@elizaos/plugin-scheduling").ScheduledTaskLogEntry,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_scheduling.life_scheduled_task_log (
        id, agent_id, task_id, occurred_at, transition, reason, rolled_up, detail_json
      ) VALUES (
        ${sqlQuote(entry.logId)},
        ${sqlQuote(entry.agentId)},
        ${sqlQuote(entry.taskId)},
        ${sqlQuote(entry.occurredAtIso)},
        ${sqlQuote(entry.transition)},
        ${sqlText(entry.reason ?? null)},
        ${sqlBoolean(entry.rolledUp)},
        ${sqlText(entry.detail ? JSON.stringify(entry.detail) : null)}
      )`,
    );
  }

  async listScheduledTaskLog(args: {
    agentId: string;
    taskId?: string;
    sinceIso?: string;
    untilIso?: string;
    excludeRollups?: boolean;
    limit?: number;
  }): Promise<import("@elizaos/plugin-scheduling").ScheduledTaskLogEntry[]> {
    const clauses: string[] = [`agent_id = ${sqlQuote(args.agentId)}`];
    if (args.taskId) clauses.push(`task_id = ${sqlQuote(args.taskId)}`);
    if (args.sinceIso)
      clauses.push(`occurred_at >= ${sqlQuote(args.sinceIso)}`);
    if (args.untilIso) clauses.push(`occurred_at < ${sqlQuote(args.untilIso)}`);
    if (args.excludeRollups) clauses.push(`rolled_up = FALSE`);
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${sqlInteger(args.limit)}`
        : "";
    // Single-task reads stay chronological (the log-view contract); the
    // cross-task shape returns most-recent-first so the LIMIT keeps the
    // entries a recap actually wants instead of the oldest rows in the table.
    const order = args.taskId ? "ASC" : "DESC";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_scheduling.life_scheduled_task_log
        WHERE ${clauses.join(" AND ")}
        ORDER BY occurred_at ${order}
        ${limit}`,
    );
    return rows.map(parseScheduledTaskLogRow);
  }

  async rollupScheduledTaskLog(args: {
    agentId: string;
    olderThanIso: string;
  }): Promise<{ rolledUp: number; deletedRaw: number }> {
    // Read all expired raw rows for the agent.
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_scheduling.life_scheduled_task_log
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND rolled_up = FALSE
          AND occurred_at < ${sqlQuote(args.olderThanIso)}`,
    );
    if (rows.length === 0) {
      return { rolledUp: 0, deletedRaw: 0 };
    }
    const summary = new Map<
      string,
      {
        taskId: string;
        transition: string;
        dayIso: string;
        count: number;
        firstReason: string | null;
      }
    >();
    for (const r of rows) {
      const occurredAt = toText(r.occurred_at);
      const dayIso = occurredAt.slice(0, 10);
      const key = `${toText(r.task_id)}::${dayIso}::${toText(r.transition)}`;
      const existing = summary.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        summary.set(key, {
          taskId: toText(r.task_id),
          transition: toText(r.transition),
          dayIso,
          count: 1,
          firstReason: typeof r.reason === "string" ? r.reason : null,
        });
      }
    }
    // Delete the raw rows we just summarized.
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_scheduling.life_scheduled_task_log
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND rolled_up = FALSE
          AND occurred_at < ${sqlQuote(args.olderThanIso)}`,
    );
    let counter = 0;
    for (const s of summary.values()) {
      counter += 1;
      const id = `rollup-${s.taskId}-${s.dayIso}-${s.transition}-${counter}`;
      await executeRawSql(
        this.runtime,
        `INSERT INTO app_scheduling.life_scheduled_task_log (
          id, agent_id, task_id, occurred_at, transition, reason, rolled_up, detail_json
        ) VALUES (
          ${sqlQuote(id)},
          ${sqlQuote(args.agentId)},
          ${sqlQuote(s.taskId)},
          ${sqlQuote(`${s.dayIso}T00:00:00.000Z`)},
          ${sqlQuote(s.transition)},
          ${sqlText(s.firstReason ?? null)},
          ${sqlBoolean(true)},
          ${sqlText(JSON.stringify({ rollupCount: s.count }))}
        )`,
      );
    }
    return { rolledUp: summary.size, deletedRaw: rows.length };
  }
}
