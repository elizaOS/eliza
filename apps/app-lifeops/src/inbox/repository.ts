import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  getRuntimeDbCacheKey,
  parseJsonArray,
  sqlBoolean,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "../lifeops/sql.js";
import type {
  OwnerAction,
  TriageClassification,
  TriageEntry,
  TriageExample,
  TriageUrgency,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema guard (one-time migration per DB connection)
// ---------------------------------------------------------------------------

const schemaReady = new WeakSet<object>();
const schemaInitializing = new WeakMap<object, Promise<void>>();

async function ensureSchema(runtime: IAgentRuntime): Promise<void> {
  const key = getRuntimeDbCacheKey(runtime);
  if (schemaReady.has(key)) return;

  let pending = schemaInitializing.get(key);
  if (pending) {
    await pending;
    return;
  }

  pending = (async () => {
    try {
      await runMigration(runtime);
      schemaReady.add(key);
    } finally {
      schemaInitializing.delete(key);
    }
  })();
  schemaInitializing.set(key, pending);
  await pending;
}

async function runMigration(runtime: IAgentRuntime): Promise<void> {
  await executeRawSql(runtime, "BEGIN");
  try {
    await executeRawSql(runtime, "SAVEPOINT inbox_schema");
    try {
      await executeRawSql(
        runtime,
        `CREATE TABLE IF NOT EXISTS inbox_triage_entries (
          id              TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          source          TEXT NOT NULL,
          source_room_id  TEXT,
          source_entity_id TEXT,
          source_message_id TEXT,
          channel_name    TEXT NOT NULL,
          channel_type    TEXT NOT NULL,
          deep_link       TEXT,
          classification  TEXT NOT NULL,
          urgency         TEXT NOT NULL DEFAULT 'low',
          confidence      REAL NOT NULL DEFAULT 0.5,
          snippet         TEXT NOT NULL,
          sender_name     TEXT,
          thread_context  TEXT,
          triage_reasoning TEXT,
          suggested_response TEXT,
          draft_response  TEXT,
          auto_replied    BOOLEAN NOT NULL DEFAULT FALSE,
          resolved        BOOLEAN NOT NULL DEFAULT FALSE,
          resolved_at     TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        )`,
      );
      await executeRawSql(
        runtime,
        `CREATE INDEX IF NOT EXISTS idx_inbox_triage_resolved
           ON inbox_triage_entries (resolved, classification)`,
      );
      await executeRawSql(
        runtime,
        `CREATE INDEX IF NOT EXISTS idx_inbox_triage_source_msg
           ON inbox_triage_entries (source_message_id)`,
      );
      await executeRawSql(
        runtime,
        `CREATE INDEX IF NOT EXISTS idx_inbox_triage_created
           ON inbox_triage_entries (created_at DESC)`,
      );

      await executeRawSql(
        runtime,
        `CREATE TABLE IF NOT EXISTS inbox_triage_examples (
          id              TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          source          TEXT NOT NULL,
          snippet         TEXT NOT NULL,
          classification  TEXT NOT NULL,
          owner_action    TEXT NOT NULL,
          owner_classification TEXT,
          context_json    TEXT,
          created_at      TEXT NOT NULL
        )`,
      );

      await executeRawSql(runtime, "RELEASE SAVEPOINT inbox_schema");
    } catch (error) {
      await executeRawSql(runtime, "ROLLBACK TO SAVEPOINT inbox_schema").catch(
        () => {},
      );
      throw error;
    }
    await executeRawSql(runtime, "COMMIT");
  } catch (error) {
    await executeRawSql(runtime, "ROLLBACK").catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function parseTriageEntry(row: Record<string, unknown>): TriageEntry {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source),
    sourceRoomId: toText(row.source_room_id) || null,
    sourceEntityId: toText(row.source_entity_id) || null,
    sourceMessageId: toText(row.source_message_id) || null,
    channelName: toText(row.channel_name),
    channelType: toText(row.channel_type),
    deepLink: toText(row.deep_link) || null,
    classification: toText(row.classification) as TriageClassification,
    urgency: toText(row.urgency, "low") as TriageUrgency,
    confidence: toNumber(row.confidence, 0.5),
    snippet: toText(row.snippet),
    senderName: toText(row.sender_name) || null,
    threadContext: row.thread_context
      ? parseJsonArray<string>(row.thread_context)
      : null,
    triageReasoning: toText(row.triage_reasoning) || null,
    suggestedResponse: toText(row.suggested_response) || null,
    draftResponse: toText(row.draft_response) || null,
    autoReplied: toBoolean(row.auto_replied, false),
    resolved: toBoolean(row.resolved, false),
    resolvedAt: toText(row.resolved_at) || null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseTriageExample(row: Record<string, unknown>): TriageExample {
  const contextStr = toText(row.context_json);
  let contextJson: Record<string, unknown> | null = null;
  if (contextStr) {
    try {
      contextJson = JSON.parse(contextStr) as Record<string, unknown>;
    } catch {
      contextJson = null;
    }
  }
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source),
    snippet: toText(row.snippet),
    classification: toText(row.classification) as TriageClassification,
    ownerAction: toText(row.owner_action) as OwnerAction,
    ownerClassification: (toText(row.owner_classification) ||
      null) as TriageClassification | null,
    contextJson,
    createdAt: toText(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function sqlJsonArray(value: string[] | null | undefined): string {
  if (!value || value.length === 0) return "NULL";
  return sqlQuote(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class InboxTriageRepository {
  constructor(private runtime: IAgentRuntime) {}

  private get agentId(): string {
    return this.runtime.agentId;
  }

  private async ready(): Promise<void> {
    await ensureSchema(this.runtime);
  }

  // ---- Triage entries ----

  async storeTriage(opts: {
    source: string;
    sourceRoomId?: string;
    sourceEntityId?: string;
    sourceMessageId?: string;
    channelName: string;
    channelType: string;
    deepLink?: string;
    classification: TriageClassification;
    urgency: TriageUrgency;
    confidence: number;
    snippet: string;
    senderName?: string;
    threadContext?: string[];
    triageReasoning?: string;
    suggestedResponse?: string;
  }): Promise<TriageEntry> {
    await this.ready();
    const id = newId();
    const now = isoNow();

    await executeRawSql(
      this.runtime,
      `INSERT INTO inbox_triage_entries (
        id, agent_id, source, source_room_id, source_entity_id, source_message_id,
        channel_name, channel_type, deep_link, classification, urgency, confidence,
        snippet, sender_name, thread_context, triage_reasoning, suggested_response,
        auto_replied, resolved, created_at, updated_at
      ) VALUES (
        ${sqlText(id)}, ${sqlText(this.agentId)}, ${sqlText(opts.source)},
        ${sqlText(opts.sourceRoomId ?? null)}, ${sqlText(opts.sourceEntityId ?? null)},
        ${sqlText(opts.sourceMessageId ?? null)}, ${sqlText(opts.channelName)},
        ${sqlText(opts.channelType)}, ${sqlText(opts.deepLink ?? null)},
        ${sqlText(opts.classification)}, ${sqlText(opts.urgency)},
        ${sqlNumber(opts.confidence)}, ${sqlText(opts.snippet)},
        ${sqlText(opts.senderName ?? null)}, ${sqlJsonArray(opts.threadContext)},
        ${sqlText(opts.triageReasoning ?? null)}, ${sqlText(opts.suggestedResponse ?? null)},
        FALSE, FALSE, ${sqlText(now)}, ${sqlText(now)}
      )`,
    );

    return {
      id,
      agentId: this.agentId,
      source: opts.source,
      sourceRoomId: opts.sourceRoomId ?? null,
      sourceEntityId: opts.sourceEntityId ?? null,
      sourceMessageId: opts.sourceMessageId ?? null,
      channelName: opts.channelName,
      channelType: opts.channelType,
      deepLink: opts.deepLink ?? null,
      classification: opts.classification,
      urgency: opts.urgency,
      confidence: opts.confidence,
      snippet: opts.snippet,
      senderName: opts.senderName ?? null,
      threadContext: opts.threadContext ?? null,
      triageReasoning: opts.triageReasoning ?? null,
      suggestedResponse: opts.suggestedResponse ?? null,
      draftResponse: null,
      autoReplied: false,
      resolved: false,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getUnresolved(opts?: { limit?: number }): Promise<TriageEntry[]> {
    await this.ready();
    const limit = opts?.limit ?? 50;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND resolved = FALSE
       ORDER BY
         CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async getByClassification(
    classification: TriageClassification,
    opts?: { limit?: number; unresolvedOnly?: boolean },
  ): Promise<TriageEntry[]> {
    await this.ready();
    const limit = opts?.limit ?? 50;
    const unresolvedOnly = opts?.unresolvedOnly !== false;
    const resolvedClause = unresolvedOnly ? "AND resolved = FALSE" : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND classification = ${sqlText(classification)}
         ${resolvedClause}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async getById(id: string): Promise<TriageEntry | null> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
       LIMIT 1`,
    );
    return rows.length > 0 ? parseTriageEntry(rows[0]) : null;
  }

  async getBySourceMessageId(
    sourceMessageId: string,
  ): Promise<TriageEntry | null> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE source_message_id = ${sqlText(sourceMessageId)}
         AND agent_id = ${sqlText(this.agentId)}
       LIMIT 1`,
    );
    return rows.length > 0 ? parseTriageEntry(rows[0]) : null;
  }

  async getBySourceMessageIds(
    sourceMessageIds: string[],
  ): Promise<Set<string>> {
    if (sourceMessageIds.length === 0) return new Set();
    await this.ready();
    const inClause = sourceMessageIds.map((id) => sqlText(id)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT source_message_id FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND source_message_id IN (${inClause})`,
    );
    return new Set(rows.map((r) => toText(r.source_message_id)));
  }

  async markResolved(
    id: string,
    opts?: { draftResponse?: string; autoReplied?: boolean },
  ): Promise<void> {
    await this.ready();
    const now = isoNow();
    const sets = [
      `resolved = TRUE`,
      `resolved_at = ${sqlText(now)}`,
      `updated_at = ${sqlText(now)}`,
    ];
    if (opts?.draftResponse !== undefined) {
      sets.push(`draft_response = ${sqlText(opts.draftResponse)}`);
    }
    if (opts?.autoReplied !== undefined) {
      sets.push(`auto_replied = ${sqlBoolean(opts.autoReplied)}`);
    }
    await executeRawSql(
      this.runtime,
      `UPDATE inbox_triage_entries
       SET ${sets.join(", ")}
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}`,
    );
  }

  async getRecentForDigest(sinceIso: string): Promise<TriageEntry[]> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND created_at >= ${sqlText(sinceIso)}
         AND classification != 'ignore'
       ORDER BY
         CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         created_at DESC`,
    );
    return rows.map(parseTriageEntry);
  }

  async getRecentAutoReplies(limit = 5): Promise<TriageEntry[]> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND auto_replied = TRUE
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async countAutoRepliesSince(sinceIso: string): Promise<number> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS cnt FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND auto_replied = TRUE
         AND created_at >= ${sqlText(sinceIso)}`,
    );
    return toNumber(rows[0]?.cnt, 0);
  }

  async cleanupOlderThan(olderThanIso: string): Promise<number> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND resolved = TRUE
         AND created_at < ${sqlText(olderThanIso)}
       RETURNING id`,
    );
    return rows.length;
  }

  // ---- Few-shot examples ----

  async storeExample(opts: {
    source: string;
    snippet: string;
    classification: TriageClassification;
    ownerAction: OwnerAction;
    ownerClassification?: TriageClassification;
    contextJson?: Record<string, unknown>;
  }): Promise<TriageExample> {
    await this.ready();
    const id = newId();
    const now = isoNow();
    const contextStr = opts.contextJson
      ? JSON.stringify(opts.contextJson)
      : null;

    await executeRawSql(
      this.runtime,
      `INSERT INTO inbox_triage_examples (
        id, agent_id, source, snippet, classification, owner_action,
        owner_classification, context_json, created_at
      ) VALUES (
        ${sqlText(id)}, ${sqlText(this.agentId)}, ${sqlText(opts.source)},
        ${sqlText(opts.snippet)}, ${sqlText(opts.classification)},
        ${sqlText(opts.ownerAction)}, ${sqlText(opts.ownerClassification ?? null)},
        ${sqlText(contextStr)}, ${sqlText(now)}
      )`,
    );

    return {
      id,
      agentId: this.agentId,
      source: opts.source,
      snippet: opts.snippet,
      classification: opts.classification,
      ownerAction: opts.ownerAction,
      ownerClassification: opts.ownerClassification ?? null,
      contextJson: opts.contextJson ?? null,
      createdAt: now,
    };
  }

  async getExamples(limit = 10): Promise<TriageExample[]> {
    await this.ready();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM inbox_triage_examples
       WHERE agent_id = ${sqlText(this.agentId)}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageExample);
  }
}
