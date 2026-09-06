/** Registers authoritative plugin schemas and applies guarded LifeOps compatibility repairs in dependency order. */
import { knowledgeGraphSchema } from "@elizaos/agent/services/knowledge-graph";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { browserBridgeSchema } from "@elizaos/plugin-browser/schema";
import { calendarSchema } from "@elizaos/plugin-calendar/service/schema";
import { goalsDbSchema } from "@elizaos/plugin-goals/db/schema";
import { inboxDbSchema } from "@elizaos/plugin-inbox/db/schema";
import { remindersDbSchema } from "@elizaos/plugin-reminders/db/schema";
import { schedulingDbSchema } from "@elizaos/plugin-scheduling";
import { resolveBrowserBridgeTable } from "./repositories/browser-tables.js";
import { tableExists } from "./repositories/schema-compatibility.js";
import {
  assertWorkflowRunIdempotencyIndexDefinition,
  WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_BATCH_SIZE,
  WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_MARKER,
  WORKFLOW_RUN_IDEMPOTENCY_INDEX_DEFINITION_QUERY,
} from "./repositories/workflow-schema.js";
import { lifeOpsSchema } from "./schema.js";
import {
  REMINDER_REVIEW_AT_METADATA_KEY,
  REMINDER_REVIEW_STATUS_METADATA_KEY,
} from "./service-constants.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlInteger,
  sqlQuote,
  toText,
  withTransaction,
} from "./sql.js";
export async function bootstrapSchema(runtime: IAgentRuntime): Promise<void> {
  const adapter = runtime.adapter;
  if (!adapter || typeof adapter.runPluginMigrations !== "function") {
    return;
  }
  if (typeof adapter.isReady === "function" && !(await adapter.isReady())) {
    return;
  }
  // Production's `eliza` plugin owns both the knowledge-graph and pendant
  // session tables. Re-registering only knowledgeGraphSchema under that same
  // owner name replaces the migration service's full schema snapshot and
  // makes every later route bootstrap look like a destructive table drop.
  // Reuse the runtime's authoritative schema when present; isolated test
  // harnesses without the host plugin still fall back to the graph subset.
  const runtimeElizaSchema = runtime.plugins.find(
    (plugin) => plugin.name === "eliza",
  )?.schema;
  await adapter.runPluginMigrations(
    [
      {
        name: "@elizaos/plugin-browser",
        schema: browserBridgeSchema,
      },
      {
        name: "@elizaos/plugin-personal-assistant",
        schema: lifeOpsSchema,
      },
      // Inbox-triage tables were carved to @elizaos/plugin-inbox (app_inbox);
      // PA auto-registers that plugin in production. Mirror it here so test
      // harnesses that only call bootstrapSchema still materialize the
      // app_inbox tables the inbox repositories read.
      {
        name: "@elizaos/plugin-inbox",
        schema: inboxDbSchema,
      },
      // Reminder tables were carved to @elizaos/plugin-reminders
      // (app_reminders); PA auto-registers that plugin in production and its
      // reminder repository methods read/write those tables via raw SQL.
      // Mirror the schema here, under the plugin's registered name, for the
      // same test-harness reason as app_inbox above.
      {
        name: "@elizaos/plugin-reminders",
        schema: remindersDbSchema,
      },
      // Calendar tables were carved to @elizaos/plugin-calendar
      // (app_calendar); PA's calendar feed reads go through raw SQL against
      // app_calendar.life_calendar_events. The plugin registers under the
      // name "calendar" — keep that name so migration bookkeeping matches
      // production.
      {
        name: "calendar",
        schema: calendarSchema,
      },
      // Goal tables were carved to @elizaos/plugin-goals (app_goals); PA's
      // overview/goal reads go through raw SQL against
      // app_goals.life_goal_definitions. Same mirroring rationale as above.
      {
        name: "@elizaos/plugin-goals",
        schema: goalsDbSchema,
      },
      // ScheduledTask tables were carved to @elizaos/plugin-scheduling
      // (app_scheduling); the runner store and these PA repository methods
      // now read/write those tables via raw SQL. Mirror the schema here so
      // test harnesses that only call bootstrapSchema still materialize
      // them.
      {
        name: "@elizaos/plugin-scheduling",
        schema: schedulingDbSchema,
      },
      // The knowledge-graph tables are runtime-owned (registered by the
      // agent "eliza" plugin in production). Migrate them under the same
      // plugin name here so test harnesses that only call
      // bootstrapSchema still get the app_lifeops graph tables.
      {
        name: "eliza",
        schema: runtimeElizaSchema ?? knowledgeGraphSchema,
      },
    ],
    {
      verbose: process.env.NODE_ENV !== "production",
      force: process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true",
      dryRun: false,
    },
  );
  await ensureActivitySignalColumns(runtime);
  await ensureSchedulingNegotiationColumns(runtime);
  await ensureReminderReviewColumns(runtime);
  await ensureBrowserBridgeCompanionTokenColumns(runtime);
  await ensureConnectorAccountColumns(runtime);
  await ensureGmailSyncColumns(runtime);
  await ensureInboxCacheIndexes(runtime);
  await ensureWorkflowRunIdempotencyKey(runtime);
  await ensureDefinitionCreationIdentity(runtime);
}

export async function ensureWorkflowRunIdempotencyKey(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!(await tableExists(runtime, "app_lifeops.life_workflow_runs"))) {
    return;
  }
  const markerQuery = `SELECT description.description
         FROM pg_catalog.pg_description AS description
         JOIN pg_catalog.pg_class AS index_class
           ON index_class.oid = description.objoid
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = index_class.relnamespace
        WHERE namespace.nspname = 'app_lifeops'
          AND index_class.relname = 'idx_life_workflow_runs_idempotency'
          AND description.classoid = 'pg_catalog.pg_class'::regclass
          AND description.objsubid = 0
          AND description.description = ${sqlQuote(WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_MARKER)}
        LIMIT 1`;
  const markerRows = await executeRawSql(runtime, markerQuery);
  if (markerRows.length > 0) {
    assertWorkflowRunIdempotencyIndexDefinition(
      await executeRawSql(
        runtime,
        WORKFLOW_RUN_IDEMPOTENCY_INDEX_DEFINITION_QUERY,
      ),
    );
    return;
  }
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_workflow_runs ADD COLUMN IF NOT EXISTS idempotency_key TEXT",
  );
  await withTransaction(runtime, async (tx) => {
    // Serialize concurrent bootstraps and stop legacy INSERTs from landing
    // behind the keyset cursor while the one-time scan is in flight.
    await executeRawSqlTx(
      tx,
      "LOCK TABLE app_lifeops.life_workflow_runs IN SHARE ROW EXCLUSIVE MODE",
    );
    if ((await executeRawSqlTx(tx, markerQuery)).length > 0) {
      assertWorkflowRunIdempotencyIndexDefinition(
        await executeRawSqlTx(
          tx,
          WORKFLOW_RUN_IDEMPOTENCY_INDEX_DEFINITION_QUERY,
        ),
      );
      return;
    }
    await executeRawSqlTx(
      tx,
      `CREATE INDEX IF NOT EXISTS idx_life_workflow_runs_idempotency_backfill_scan
           ON app_lifeops.life_workflow_runs (started_at DESC, id DESC)
        WHERE idempotency_key IS NULL`,
    );
    await executeRawSqlTx(
      tx,
      `WITH ranked_existing AS (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY agent_id, workflow_id, idempotency_key
                    ORDER BY started_at DESC, id DESC
                  ) AS row_number
             FROM app_lifeops.life_workflow_runs
            WHERE idempotency_key IS NOT NULL
         )
         UPDATE app_lifeops.life_workflow_runs AS run
            SET idempotency_key = NULL
           FROM ranked_existing
          WHERE run.id = ranked_existing.id
            AND ranked_existing.row_number > 1`,
    );

    let cursor: { startedAt: string; id: string } | null = null;
    while (true) {
      const cursorClause = cursor
        ? `AND (started_at, id) < (${sqlQuote(cursor.startedAt)}, ${sqlQuote(cursor.id)})`
        : "";
      const rows = await executeRawSqlTx(
        tx,
        `SELECT id, agent_id, workflow_id, started_at, result_json
             FROM app_lifeops.life_workflow_runs
            WHERE idempotency_key IS NULL
              ${cursorClause}
            ORDER BY started_at DESC, id DESC
            LIMIT ${WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_BATCH_SIZE}`,
      );
      if (rows.length === 0) {
        break;
      }

      const candidates: Array<{
        id: string;
        agentId: string;
        workflowId: string;
        idempotencyKey: string;
        ordinal: number;
      }> = [];
      for (const [ordinal, row] of rows.entries()) {
        let result: Record<string, unknown>;
        try {
          result = parseJsonRecord(row.result_json);
        } catch {
          // error-policy:J3 corrupt stored JSON produces an explicit skip
          // rather than a fabricated key, so one bad historical row cannot
          // block the compatibility migration for every other run. Logged
          // with the row id, because "backfill completed" and "backfill
          // silently dropped 4,000 rows" must not look identical.
          logger.warn(
            { workflowRunId: row.id },
            "[lifeops-repository] skipped a workflow run whose stored result could not be parsed during idempotency backfill",
          );
          continue;
        }
        const legacyKey = result.idempotencyKey;
        if (
          typeof legacyKey !== "string" ||
          legacyKey.length === 0 ||
          legacyKey.length > 256 ||
          legacyKey.includes("\0")
        ) {
          continue;
        }
        candidates.push({
          id: toText(row.id),
          agentId: toText(row.agent_id),
          workflowId: toText(row.workflow_id),
          idempotencyKey: legacyKey,
          ordinal,
        });
      }

      if (candidates.length > 0) {
        const values = candidates
          .map(
            (candidate) =>
              `(${sqlQuote(candidate.id)}, ${sqlQuote(candidate.agentId)}, ${sqlQuote(candidate.workflowId)}, ${sqlQuote(candidate.idempotencyKey)}, ${sqlInteger(candidate.ordinal)})`,
          )
          .join(",\n");
        await executeRawSqlTx(
          tx,
          `WITH candidates (
               id, agent_id, workflow_id, idempotency_key, ordinal
             ) AS (
               VALUES ${values}
             ), ranked AS (
               SELECT candidate.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY candidate.agent_id,
                                     candidate.workflow_id,
                                     candidate.idempotency_key
                        ORDER BY candidate.ordinal ASC
                      ) AS row_number
                 FROM candidates AS candidate
             ), available AS (
               SELECT candidate.*
                 FROM ranked AS candidate
                WHERE candidate.row_number = 1
                  AND NOT EXISTS (
                    SELECT 1
                      FROM app_lifeops.life_workflow_runs AS claimed
                     WHERE claimed.agent_id = candidate.agent_id
                       AND claimed.workflow_id = candidate.workflow_id
                       AND claimed.idempotency_key = candidate.idempotency_key
                  )
             )
             UPDATE app_lifeops.life_workflow_runs AS run
                SET idempotency_key = candidate.idempotency_key
               FROM available AS candidate
              WHERE run.id = candidate.id
                AND run.agent_id = candidate.agent_id
                AND run.workflow_id = candidate.workflow_id
                AND run.idempotency_key IS NULL`,
        );
      }

      const last = rows.at(-1);
      if (!last) {
        break;
      }
      cursor = {
        startedAt: toText(last.started_at),
        id: toText(last.id),
      };
    }

    await executeRawSqlTx(
      tx,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_life_workflow_runs_idempotency
         ON app_lifeops.life_workflow_runs (
           agent_id, workflow_id, idempotency_key
         )
        WHERE idempotency_key IS NOT NULL`,
    );
    // `IF NOT EXISTS` silently accepts any pre-existing index with this
    // name. A foreign non-unique (or wrong-column/predicate) index would
    // pass creation and then be stamped as the durable completion marker
    // while electing nothing. Verify the live definition before stamping;
    // the transaction rolls back on mismatch so a later boot retries after
    // the operator drops or renames the conflicting index.
    assertWorkflowRunIdempotencyIndexDefinition(
      await executeRawSqlTx(
        tx,
        WORKFLOW_RUN_IDEMPOTENCY_INDEX_DEFINITION_QUERY,
      ),
    );
    await executeRawSqlTx(
      tx,
      `COMMENT ON INDEX app_lifeops.idx_life_workflow_runs_idempotency
           IS ${sqlQuote(WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_MARKER)}`,
    );
    await executeRawSqlTx(
      tx,
      "DROP INDEX IF EXISTS app_lifeops.idx_life_workflow_runs_idempotency_backfill_scan",
    );
  });
}

export async function ensureSchedulingNegotiationColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  if (
    !(await tableExists(runtime, "app_lifeops.life_scheduling_negotiations"))
  ) {
    return;
  }
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_scheduling_negotiations ADD COLUMN IF NOT EXISTS accepted_proposal_id TEXT",
  );
}

export async function ensureActivitySignalColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!(await tableExists(runtime, "app_lifeops.life_activity_signals"))) {
    return;
  }
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_activity_signals ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT ''",
  );
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_activity_signals ADD COLUMN IF NOT EXISTS idle_state TEXT",
  );
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_activity_signals ADD COLUMN IF NOT EXISTS idle_time_seconds INTEGER",
  );
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_activity_signals ADD COLUMN IF NOT EXISTS on_battery BOOLEAN",
  );
  await executeRawSql(
    runtime,
    "CREATE INDEX IF NOT EXISTS idx_life_activity_signals_agent ON app_lifeops.life_activity_signals (agent_id, observed_at)",
  );
}

export async function ensureBrowserBridgeCompanionTokenColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  const companionsTable = await resolveBrowserBridgeTable(
    runtime,
    "companions",
  );
  if (!(await tableExists(runtime, companionsTable))) {
    return;
  }
  const companionTokenColumnRepairs = [
    `ALTER TABLE ${companionsTable} ADD COLUMN IF NOT EXISTS pairing_token_expires_at TEXT`,
    `ALTER TABLE ${companionsTable} ADD COLUMN IF NOT EXISTS pairing_token_revoked_at TEXT`,
  ];
  for (const statement of companionTokenColumnRepairs) {
    await executeRawSql(runtime, statement);
  }
}

export async function ensureReminderReviewColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!(await tableExists(runtime, "app_reminders.life_reminder_attempts"))) {
    return;
  }
  const reminderReviewColumnRepairs = [
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_at TEXT",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_status TEXT",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_claimed_at TEXT",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_claimed_by TEXT",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_attempt_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_next_retry_at TEXT",
    "ALTER TABLE app_reminders.life_reminder_attempts ADD COLUMN IF NOT EXISTS review_last_error TEXT",
  ];
  for (const statement of reminderReviewColumnRepairs) {
    await executeRawSql(runtime, statement);
  }
  await executeRawSql(
    runtime,
    `UPDATE app_reminders.life_reminder_attempts
          SET review_at = delivery_metadata_json::jsonb ->> ${sqlQuote(REMINDER_REVIEW_AT_METADATA_KEY)}
        WHERE review_at IS NULL
          AND delivery_metadata_json::jsonb ? ${sqlQuote(REMINDER_REVIEW_AT_METADATA_KEY)}`,
  );
  await executeRawSql(
    runtime,
    `UPDATE app_reminders.life_reminder_attempts
          SET review_status = delivery_metadata_json::jsonb ->> ${sqlQuote(REMINDER_REVIEW_STATUS_METADATA_KEY)}
        WHERE review_status IS NULL
          AND delivery_metadata_json::jsonb ? ${sqlQuote(REMINDER_REVIEW_STATUS_METADATA_KEY)}`,
  );
  await executeRawSql(
    runtime,
    `CREATE INDEX IF NOT EXISTS idx_life_reminder_attempts_review_due
         ON app_reminders.life_reminder_attempts (agent_id, review_status, review_at)`,
  );
}

export async function ensureConnectorAccountColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  const tableColumnRepairs: Array<{
    table: string;
    statements: string[];
  }> = [
    {
      table: "app_lifeops.life_connector_grants",
      statements: [
        "ALTER TABLE app_lifeops.life_connector_grants ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
        "CREATE INDEX IF NOT EXISTS idx_life_connector_grants_account ON app_lifeops.life_connector_grants (agent_id, provider, connector_account_id)",
      ],
    },
    // Calendar tables were carved to @elizaos/plugin-calendar (app_calendar);
    // these repairs stay on app_lifeops to keep the migration SOURCE
    // column-complete so CalendarMigrationService's row copy is shape-safe.
    {
      table: "app_lifeops.life_calendar_events",
      statements: [
        "ALTER TABLE app_lifeops.life_calendar_events ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
        "ALTER TABLE app_lifeops.life_calendar_events ADD COLUMN IF NOT EXISTS purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE app_lifeops.life_calendar_events ADD COLUMN IF NOT EXISTS purge_resync_reason TEXT",
        "CREATE INDEX IF NOT EXISTS idx_life_calendar_events_account ON app_lifeops.life_calendar_events (agent_id, provider, connector_account_id)",
      ],
    },
    {
      table: "app_lifeops.life_calendar_sync_states",
      statements: [
        "ALTER TABLE app_lifeops.life_calendar_sync_states ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
        "ALTER TABLE app_lifeops.life_calendar_sync_states ADD COLUMN IF NOT EXISTS purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE app_lifeops.life_calendar_sync_states ADD COLUMN IF NOT EXISTS purge_resync_reason TEXT",
        "CREATE INDEX IF NOT EXISTS idx_life_calendar_sync_states_account ON app_lifeops.life_calendar_sync_states (agent_id, provider, connector_account_id)",
      ],
    },
    {
      table: "app_lifeops.life_gmail_messages",
      statements: [
        "ALTER TABLE app_lifeops.life_gmail_messages ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
        "CREATE INDEX IF NOT EXISTS idx_life_gmail_messages_account ON app_lifeops.life_gmail_messages (agent_id, provider, connector_account_id)",
      ],
    },
    {
      table: "app_lifeops.life_inbox_messages",
      statements: [
        "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS connector_account_id TEXT",
        "CREATE INDEX IF NOT EXISTS idx_life_inbox_messages_account ON app_lifeops.life_inbox_messages (agent_id, connector_account_id)",
      ],
    },
  ];

  for (const repair of tableColumnRepairs) {
    if (!(await tableExists(runtime, repair.table))) continue;
    for (const statement of repair.statements) {
      await executeRawSql(runtime, statement);
    }
  }
}

export async function ensureGmailSyncColumns(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!(await tableExists(runtime, "app_lifeops.life_gmail_sync_states"))) {
    return;
  }
  for (const statement of [
    "ALTER TABLE app_lifeops.life_gmail_sync_states ADD COLUMN IF NOT EXISTS history_id TEXT",
    "ALTER TABLE app_lifeops.life_gmail_sync_states ADD COLUMN IF NOT EXISTS cursor_status TEXT NOT NULL DEFAULT 'seeded'",
    "ALTER TABLE app_lifeops.life_gmail_sync_states ADD COLUMN IF NOT EXISTS full_resync_reason TEXT",
  ]) {
    await executeRawSql(runtime, statement);
  }
}

export async function ensureInboxCacheIndexes(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!(await tableExists(runtime, "app_lifeops.life_inbox_messages"))) {
    return;
  }

  await executeRawSql(
    runtime,
    `DELETE FROM app_lifeops.life_inbox_messages
        WHERE id IN (
          SELECT id
            FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY agent_id, channel, external_id
                       ORDER BY updated_at DESC, cached_at DESC, id DESC
                     ) AS row_number
                FROM app_lifeops.life_inbox_messages
            ) ranked
           WHERE row_number > 1
        )`,
  );
  await executeRawSql(
    runtime,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_life_inbox_messages_agent_channel_external
         ON app_lifeops.life_inbox_messages (agent_id, channel, external_id)`,
  );
  const inboxCacheColumnRepairs = [
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS thread_id TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS sender_email TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS subject TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS deep_link TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS source_ref_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS chat_type TEXT NOT NULL DEFAULT 'channel'",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS participant_count INTEGER",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS gmail_account_id TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS gmail_account_email TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS last_seen_at TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS replied_at TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS priority_score INTEGER",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS priority_category TEXT",
    "ALTER TABLE app_lifeops.life_inbox_messages ADD COLUMN IF NOT EXISTS priority_flags_json TEXT NOT NULL DEFAULT '[]'",
  ];
  for (const statement of inboxCacheColumnRepairs) {
    await executeRawSql(runtime, statement);
  }
}

/** Upgrade existing audit tables without inventing identity for legacy writes. */
export async function ensureDefinitionCreationIdentity(
  runtime: IAgentRuntime,
): Promise<void> {
  await executeRawSql(
    runtime,
    "ALTER TABLE app_lifeops.life_audit_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT",
  );
  await executeRawSql(
    runtime,
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_life_audit_events_operation ON app_lifeops.life_audit_events (agent_id, event_type, idempotency_key)",
  );
}
