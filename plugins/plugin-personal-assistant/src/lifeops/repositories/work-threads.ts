/** Owns durable work-thread state and atomic merge transitions. Target, sources, and merge events share one transaction and optimistic version checks. */

import crypto from "node:crypto";
import type { LifeOpsDatabaseContext } from "../sql.js";
import {
  executeRawSql,
  executeRawSqlTx,
  OptimisticLockError,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toText,
} from "../sql.js";
import type {
  WorkThread,
  WorkThreadEvent,
  WorkThreadListFilter,
} from "../work-threads/types.js";
import { isoNow } from "./record-values.js";
import {
  parseWorkThreadEventRow,
  parseWorkThreadRow,
} from "./work-thread-records.js";
export class WorkThreadRepository {
  constructor(private readonly runtime: LifeOpsDatabaseContext) {}
  async upsertWorkThread(
    agentId: string,
    thread: WorkThread,
    options?: { expectedVersion?: number },
  ): Promise<void> {
    const now = isoNow();
    const createdAt = thread.createdAt || now;
    const updatedAt = thread.updatedAt || now;
    const lastActivityAt = thread.lastActivityAt || updatedAt;
    const expectedVersion = options?.expectedVersion;
    if (typeof expectedVersion === "number") {
      const rows = await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_work_threads
            SET owner_entity_id = ${sqlText(thread.ownerEntityId ?? null)},
                status = ${sqlQuote(thread.status)},
                title = ${sqlQuote(thread.title)},
                summary = ${sqlQuote(thread.summary)},
                current_plan_summary = ${sqlText(thread.currentPlanSummary ?? null)},
                primary_source_ref_json = ${sqlJson(thread.primarySourceRef)},
                source_refs_json = ${sqlJson(thread.sourceRefs)},
                participant_entity_ids_json = ${sqlJson(thread.participantEntityIds)},
                current_scheduled_task_id = ${sqlText(thread.currentScheduledTaskId ?? null)},
                workflow_run_id = ${sqlText(thread.workflowRunId ?? null)},
                approval_id = ${sqlText(thread.approvalId ?? null)},
                last_message_memory_id = ${sqlText(thread.lastMessageMemoryId ?? null)},
                metadata_json = ${sqlJson(thread.metadata ?? {})},
                updated_at = ${sqlQuote(updatedAt)},
                last_activity_at = ${sqlQuote(lastActivityAt)},
                version = version + 1
          WHERE id = ${sqlQuote(thread.id)}
            AND agent_id = ${sqlQuote(agentId)}
            AND version = ${sqlInteger(expectedVersion)}
        RETURNING id`,
      );
      if (rows.length === 0) {
        throw new OptimisticLockError({
          table: "life_work_threads",
          id: thread.id,
          expectedVersion,
        });
      }
      return;
    }
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_work_threads (
        id, agent_id, owner_entity_id, status, title, summary,
        current_plan_summary, primary_source_ref_json, source_refs_json,
        participant_entity_ids_json, current_scheduled_task_id, workflow_run_id,
        approval_id, last_message_memory_id, metadata_json, created_at,
        updated_at, last_activity_at
      ) VALUES (
        ${sqlQuote(thread.id)},
        ${sqlQuote(agentId)},
        ${sqlText(thread.ownerEntityId ?? null)},
        ${sqlQuote(thread.status)},
        ${sqlQuote(thread.title)},
        ${sqlQuote(thread.summary)},
        ${sqlText(thread.currentPlanSummary ?? null)},
        ${sqlJson(thread.primarySourceRef)},
        ${sqlJson(thread.sourceRefs)},
        ${sqlJson(thread.participantEntityIds)},
        ${sqlText(thread.currentScheduledTaskId ?? null)},
        ${sqlText(thread.workflowRunId ?? null)},
        ${sqlText(thread.approvalId ?? null)},
        ${sqlText(thread.lastMessageMemoryId ?? null)},
        ${sqlJson(thread.metadata ?? {})},
        ${sqlQuote(createdAt)},
        ${sqlQuote(updatedAt)},
        ${sqlQuote(lastActivityAt)}
      )
      ON CONFLICT (id) DO UPDATE SET
        owner_entity_id = EXCLUDED.owner_entity_id,
        status = EXCLUDED.status,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_plan_summary = EXCLUDED.current_plan_summary,
        primary_source_ref_json = EXCLUDED.primary_source_ref_json,
        source_refs_json = EXCLUDED.source_refs_json,
        participant_entity_ids_json = EXCLUDED.participant_entity_ids_json,
        current_scheduled_task_id = EXCLUDED.current_scheduled_task_id,
        workflow_run_id = EXCLUDED.workflow_run_id,
        approval_id = EXCLUDED.approval_id,
        last_message_memory_id = EXCLUDED.last_message_memory_id,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at,
        last_activity_at = EXCLUDED.last_activity_at`,
    );
  }

  async getWorkThread(
    agentId: string,
    workThreadId: string,
  ): Promise<WorkThread | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_work_threads
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(workThreadId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseWorkThreadRow(row) : null;
  }

  async listWorkThreads(
    agentId: string,
    filter: WorkThreadListFilter = {},
  ): Promise<WorkThread[]> {
    const clauses: string[] = [`agent_id = ${sqlQuote(agentId)}`];
    if (filter.statuses && filter.statuses.length > 0) {
      const statuses = filter.statuses
        .map((status) => sqlQuote(status))
        .join(", ");
      clauses.push(`status IN (${statuses})`);
    }
    if (filter.ownerEntityId) {
      clauses.push(`owner_entity_id = ${sqlQuote(filter.ownerEntityId)}`);
    }
    const shouldApplyLimitInSql = !filter.roomId;
    const requestedLimit =
      typeof filter.limit === "number" && filter.limit > 0
        ? Math.floor(filter.limit)
        : null;
    const sqlLimit =
      shouldApplyLimitInSql && requestedLimit
        ? `LIMIT ${sqlInteger(requestedLimit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_work_threads
        WHERE ${clauses.join(" AND ")}
        ORDER BY last_activity_at DESC
        ${sqlLimit}`,
    );
    let threads = rows.map(parseWorkThreadRow);
    if (filter.roomId) {
      threads = threads.filter((thread) =>
        [thread.primarySourceRef, ...thread.sourceRefs].some(
          (ref) => ref.roomId === filter.roomId,
        ),
      );
    }
    if (!filter.includeCrossChannel && filter.roomId) {
      threads = threads.filter((thread) =>
        [thread.primarySourceRef, ...thread.sourceRefs].some(
          (ref) => ref.roomId === filter.roomId && ref.canRead !== false,
        ),
      );
    }
    if (!shouldApplyLimitInSql && requestedLimit) {
      threads = threads.slice(0, requestedLimit);
    }
    return threads;
  }

  async appendWorkThreadEvent(event: WorkThreadEvent): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_work_thread_events (
        id, agent_id, work_thread_id, occurred_at, type, reason, detail_json
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.workThreadId)},
        ${sqlQuote(event.occurredAt)},
        ${sqlQuote(event.type)},
        ${sqlText(event.reason ?? null)},
        ${sqlText(event.detail ? JSON.stringify(event.detail) : null)}
      )`,
    );
  }

  async appendWorkThreadEventTx(
    tx: TransactionalDb,
    event: WorkThreadEvent,
  ): Promise<void> {
    await executeRawSqlTx(
      tx,
      `INSERT INTO app_lifeops.life_work_thread_events (
        id, agent_id, work_thread_id, occurred_at, type, reason, detail_json
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.workThreadId)},
        ${sqlQuote(event.occurredAt)},
        ${sqlQuote(event.type)},
        ${sqlText(event.reason ?? null)},
        ${sqlText(event.detail ? JSON.stringify(event.detail) : null)}
      )`,
    );
  }

  async findWorkThreadMergeEvent(args: {
    agentId: string;
    targetWorkThreadId: string;
    mergeRequestId: string;
  }): Promise<{
    sourceWorkThreadIds: string[];
    occurredAt: string;
  } | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT detail_json, occurred_at
         FROM app_lifeops.life_work_thread_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND work_thread_id = ${sqlQuote(args.targetWorkThreadId)}
          AND type = ${sqlQuote("merged")}
          AND detail_json::jsonb @> ${sqlJson({
            mergeRequestId: args.mergeRequestId,
          })}::jsonb
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const detail = parseJsonRecord(row.detail_json);
    const rawSourceIds = (detail as { sourceWorkThreadIds?: unknown })
      .sourceWorkThreadIds;
    const sourceWorkThreadIds = Array.isArray(rawSourceIds)
      ? rawSourceIds.filter((s): s is string => typeof s === "string")
      : [];
    return {
      sourceWorkThreadIds,
      occurredAt: toText(row.occurred_at),
    };
  }

  async mergeWorkThreadsAtomic(args: {
    agentId: string;
    target: WorkThread;
    sources: WorkThread[];
    nextTarget: WorkThread;
    mergeRequestId: string;
    reason?: string | null;
    instruction?: string | null;
  }): Promise<{ targetWorkThreadId: string; sourceWorkThreadIds: string[] }> {
    return await import("../sql.js").then(async ({ withTransaction }) =>
      withTransaction(this.runtime, async (tx) => {
        // Idempotency check: do not re-merge if we already did this request.
        const existing = await this.findWorkThreadMergeEventTx(tx, {
          agentId: args.agentId,
          targetWorkThreadId: args.target.id,
          mergeRequestId: args.mergeRequestId,
        });
        if (existing) {
          return {
            targetWorkThreadId: args.target.id,
            sourceWorkThreadIds: existing.sourceWorkThreadIds,
          };
        }

        const updatedAt = args.nextTarget.updatedAt;
        const lastActivityAt = args.nextTarget.lastActivityAt;

        // 1. UPDATE target with version check.
        const targetRows = await executeRawSqlTx(
          tx,
          `UPDATE app_lifeops.life_work_threads
              SET summary = ${sqlQuote(args.nextTarget.summary)},
                  current_plan_summary = ${sqlText(args.nextTarget.currentPlanSummary ?? null)},
                  source_refs_json = ${sqlJson(args.nextTarget.sourceRefs)},
                  participant_entity_ids_json = ${sqlJson(args.nextTarget.participantEntityIds)},
                  last_message_memory_id = ${sqlText(args.nextTarget.lastMessageMemoryId ?? null)},
                  metadata_json = ${sqlJson(args.nextTarget.metadata ?? {})},
                  updated_at = ${sqlQuote(updatedAt)},
                  last_activity_at = ${sqlQuote(lastActivityAt)},
                  version = version + 1
            WHERE id = ${sqlQuote(args.target.id)}
              AND agent_id = ${sqlQuote(args.agentId)}
              AND version = ${sqlInteger(args.target.version)}
          RETURNING id`,
        );
        if (targetRows.length === 0) {
          throw new OptimisticLockError({
            table: "life_work_threads",
            id: args.target.id,
            expectedVersion: args.target.version,
          });
        }

        // 2. UPDATE each source with version check (status=stopped + metadata).
        const sourceMetadataPatch = (
          existingMetadata: Record<string, unknown>,
        ) => ({
          ...existingMetadata,
          mergedIntoWorkThreadId: args.target.id,
          mergeRequestId: args.mergeRequestId,
        });
        for (const source of args.sources) {
          const nextMetadata = sourceMetadataPatch(source.metadata ?? {});
          const sourceRows = await executeRawSqlTx(
            tx,
            `UPDATE app_lifeops.life_work_threads
                SET status = ${sqlQuote("stopped")},
                    metadata_json = ${sqlJson(nextMetadata)},
                    updated_at = ${sqlQuote(updatedAt)},
                    last_activity_at = ${sqlQuote(lastActivityAt)},
                    version = version + 1
              WHERE id = ${sqlQuote(source.id)}
                AND agent_id = ${sqlQuote(args.agentId)}
                AND version = ${sqlInteger(source.version)}
            RETURNING id`,
          );
          if (sourceRows.length === 0) {
            throw new OptimisticLockError({
              table: "life_work_threads",
              id: source.id,
              expectedVersion: source.version,
            });
          }
        }

        // 3. INSERT 'merged' event on target.
        const sourceIds = args.sources.map((s) => s.id);
        await this.appendWorkThreadEventTx(tx, {
          id: crypto.randomUUID(),
          agentId: args.agentId,
          workThreadId: args.target.id,
          occurredAt: updatedAt,
          type: "merged",
          reason: args.reason ?? null,
          detail: {
            mergeRequestId: args.mergeRequestId,
            sourceWorkThreadIds: sourceIds,
            instruction: args.instruction ?? null,
          },
        });

        // 4. INSERT 'merged_into' event on each source.
        for (const source of args.sources) {
          await this.appendWorkThreadEventTx(tx, {
            id: crypto.randomUUID(),
            agentId: args.agentId,
            workThreadId: source.id,
            occurredAt: updatedAt,
            type: "merged_into",
            reason: args.reason ?? null,
            detail: {
              mergeRequestId: args.mergeRequestId,
              targetWorkThreadId: args.target.id,
            },
          });
        }

        return {
          targetWorkThreadId: args.target.id,
          sourceWorkThreadIds: sourceIds,
        };
      }),
    );
  }

  private async findWorkThreadMergeEventTx(
    tx: TransactionalDb,
    args: {
      agentId: string;
      targetWorkThreadId: string;
      mergeRequestId: string;
    },
  ): Promise<{ sourceWorkThreadIds: string[]; occurredAt: string } | null> {
    const rows = await executeRawSqlTx(
      tx,
      `SELECT detail_json, occurred_at
         FROM app_lifeops.life_work_thread_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND work_thread_id = ${sqlQuote(args.targetWorkThreadId)}
          AND type = ${sqlQuote("merged")}
          AND detail_json::jsonb @> ${sqlJson({
            mergeRequestId: args.mergeRequestId,
          })}::jsonb
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const detail = parseJsonRecord(row.detail_json);
    const rawSourceIds = (detail as { sourceWorkThreadIds?: unknown })
      .sourceWorkThreadIds;
    const sourceWorkThreadIds = Array.isArray(rawSourceIds)
      ? rawSourceIds.filter((s): s is string => typeof s === "string")
      : [];
    return {
      sourceWorkThreadIds,
      occurredAt: toText(row.occurred_at),
    };
  }

  async listWorkThreadEvents(args: {
    agentId: string;
    workThreadId: string;
    limit?: number;
  }): Promise<WorkThreadEvent[]> {
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${sqlInteger(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_work_thread_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND work_thread_id = ${sqlQuote(args.workThreadId)}
        ORDER BY occurred_at DESC
        ${limit}`,
    );
    return rows.map(parseWorkThreadEventRow);
  }
}
