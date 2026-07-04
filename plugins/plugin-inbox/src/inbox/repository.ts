/**
 * InboxRepository — raw-SQL persistence for the inbox triage queue.
 *
 * Reads and writes the `app_inbox.life_inbox_triage_entries` /
 * `life_inbox_triage_examples` tables through the runtime DB handle, mapping
 * rows to strongly-typed `TriageEntry` / `TriageExample` objects. A thin raw-SQL
 * wrapper (via `../db/sql.ts`) so this plugin carries no
 * `@elizaos/plugin-personal-assistant` dependency.
 */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "../db/sql.ts";
import type {
  OwnerAction,
  TriageClassification,
  TriageEntry,
  TriageExample,
  TriageUrgency,
} from "./types.ts";

const TRIAGE_CLASSIFICATIONS = new Set<TriageClassification>([
  "ignore",
  "info",
  "notify",
  "needs_reply",
  "urgent",
]);

const TRIAGE_URGENCIES = new Set<TriageUrgency>(["low", "medium", "high"]);

const OWNER_ACTIONS = new Set<OwnerAction>([
  "confirmed",
  "reclassified",
  "edited_draft",
  "ignored",
]);

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function parseTriageClassification(value: unknown): TriageClassification {
  const normalized = toText(value).trim();
  if (TRIAGE_CLASSIFICATIONS.has(normalized as TriageClassification)) {
    return normalized as TriageClassification;
  }
  throw new Error(
    `[InboxRepository] invalid triage classification: ${normalized}`,
  );
}

function parseTriageUrgency(value: unknown): TriageUrgency {
  const normalized = toText(value).trim();
  if (TRIAGE_URGENCIES.has(normalized as TriageUrgency)) {
    return normalized as TriageUrgency;
  }
  throw new Error(`[InboxRepository] invalid triage urgency: ${normalized}`);
}

function parseNullableTriageClassification(
  value: unknown,
): TriageClassification | null {
  const normalized = toText(value).trim();
  return normalized ? parseTriageClassification(normalized) : null;
}

function parseOwnerAction(value: unknown): OwnerAction {
  const normalized = toText(value).trim();
  if (OWNER_ACTIONS.has(normalized as OwnerAction)) {
    return normalized as OwnerAction;
  }
  throw new Error(`[InboxRepository] invalid owner action: ${normalized}`);
}

function parseJsonStringArray(value: unknown, label: string): string[] {
  const entries = parseJsonArray<unknown>(value);
  const strings: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Error(`[InboxRepository] ${label} must contain strings`);
    }
    strings.push(entry);
  }
  return strings;
}

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
    classification: parseTriageClassification(row.classification),
    urgency: parseTriageUrgency(row.urgency),
    confidence: toNumber(row.confidence, 0.5),
    snippet: toText(row.snippet),
    senderName: toText(row.sender_name) || null,
    threadContext: row.thread_context
      ? parseJsonStringArray(row.thread_context, "thread_context")
      : null,
    triageReasoning: toText(row.triage_reasoning) || null,
    suggestedResponse: toText(row.suggested_response) || null,
    draftResponse: toText(row.draft_response) || null,
    autoReplied: toBoolean(row.auto_replied, false),
    snoozedUntil: toText(row.snoozed_until) || null,
    resolved: toBoolean(row.resolved, false),
    resolvedAt: toText(row.resolved_at) || null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseTriageExample(row: Record<string, unknown>): TriageExample {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source),
    snippet: toText(row.snippet),
    classification: parseTriageClassification(row.classification),
    ownerAction: parseOwnerAction(row.owner_action),
    ownerClassification: parseNullableTriageClassification(
      row.owner_classification,
    ),
    contextJson: parseJsonRecord(row.context_json),
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
//
// Reads/writes the cross-channel triage tables that remain registered by
// @elizaos/plugin-personal-assistant (`app_inbox.life_inbox_triage_entries`
// and `_examples`). The tables are inbox-domain but PA owns their migration; we
// read them directly via the runtime DB handle so this plugin carries no PA
// dependency. See README for the schema-ownership decision.
// ---------------------------------------------------------------------------

export class InboxRepository {
  constructor(private runtime: IAgentRuntime) {}

  private get agentId(): string {
    return this.runtime.agentId;
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
    const id = newId();
    const now = isoNow();

    await executeRawSql(
      this.runtime,
      `INSERT INTO app_inbox.life_inbox_triage_entries (
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
      snoozedUntil: null,
      resolved: false,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getUnresolved(opts?: {
    limit?: number;
    includeSnoozed?: boolean;
  }): Promise<TriageEntry[]> {
    const limit = opts?.limit ?? 50;
    const snoozeClause = opts?.includeSnoozed
      ? ""
      : `AND (snoozed_until IS NULL OR snoozed_until <= ${sqlText(isoNow())})`;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND resolved = FALSE
         ${snoozeClause}
       ORDER BY
         CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async getUnresolvedForSender(opts: {
    sourceEntityId?: string | null;
    senderName?: string | null;
    excludeSource?: string | null;
    limit?: number;
    includeSnoozed?: boolean;
  }): Promise<TriageEntry[]> {
    const limit = opts.limit ?? 50;
    const clauses = [`agent_id = ${sqlText(this.agentId)}`, "resolved = FALSE"];
    if (!opts.includeSnoozed) {
      clauses.push(
        `(snoozed_until IS NULL OR snoozed_until <= ${sqlText(isoNow())})`,
      );
    }

    if (opts.excludeSource) {
      clauses.push(`source != ${sqlText(opts.excludeSource)}`);
    }

    const senderClauses: string[] = [];
    if (opts.sourceEntityId) {
      senderClauses.push(`source_entity_id = ${sqlText(opts.sourceEntityId)}`);
    }
    if (opts.senderName) {
      const normalized = opts.senderName.trim().toLowerCase();
      if (normalized) {
        senderClauses.push(
          `(LOWER(sender_name) LIKE ${sqlText(`%${normalized}%`)} OR ${sqlText(normalized)} LIKE '%' || LOWER(sender_name) || '%')`,
        );
      }
    }

    if (senderClauses.length === 0) return [];
    clauses.push(`(${senderClauses.join(" OR ")})`);

    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE ${clauses.join("\n         AND ")}
       ORDER BY
         CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async getByClassification(
    classification: TriageClassification,
    opts?: {
      limit?: number;
      unresolvedOnly?: boolean;
      includeSnoozed?: boolean;
    },
  ): Promise<TriageEntry[]> {
    const limit = opts?.limit ?? 50;
    const unresolvedOnly = opts?.unresolvedOnly !== false;
    const resolvedClause = unresolvedOnly ? "AND resolved = FALSE" : "";
    const snoozeClause =
      unresolvedOnly && !opts?.includeSnoozed
        ? `AND (snoozed_until IS NULL OR snoozed_until <= ${sqlText(isoNow())})`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND classification = ${sqlText(classification)}
         ${resolvedClause}
         ${snoozeClause}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async getById(id: string): Promise<TriageEntry | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
       LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseTriageEntry(row) : null;
  }

  async getBySourceMessageId(
    sourceMessageId: string,
  ): Promise<TriageEntry | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE source_message_id = ${sqlText(sourceMessageId)}
         AND agent_id = ${sqlText(this.agentId)}
       LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseTriageEntry(row) : null;
  }

  async getBySourceMessageIds(
    sourceMessageIds: string[],
  ): Promise<Set<string>> {
    if (sourceMessageIds.length === 0) return new Set();
    const inClause = sourceMessageIds.map((id) => sqlText(id)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT source_message_id FROM app_inbox.life_inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND source_message_id IN (${inClause})`,
    );
    return new Set(rows.map((r) => toText(r.source_message_id)));
  }

  async markResolved(
    id: string,
    opts?: { draftResponse?: string; autoReplied?: boolean },
  ): Promise<void> {
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
      `UPDATE app_inbox.life_inbox_triage_entries
       SET ${sets.join(", ")}
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}`,
    );
  }

  async updateDraftResponse(id: string, draftResponse: string): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_inbox.life_inbox_triage_entries
       SET draft_response = ${sqlText(draftResponse)},
           updated_at = ${sqlText(now)}
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}`,
    );
  }

  async snoozeUntil(id: string, snoozedUntil: string): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_inbox.life_inbox_triage_entries
       SET snoozed_until = ${sqlText(snoozedUntil)},
           resolved = FALSE,
           updated_at = ${sqlText(now)}
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}`,
    );
  }

  async clearSnooze(id: string): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_inbox.life_inbox_triage_entries
       SET snoozed_until = NULL,
           updated_at = ${sqlText(now)}
       WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}`,
    );
  }

  async getRecentForDigest(sinceIso: string): Promise<TriageEntry[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
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
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND auto_replied = TRUE
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageEntry);
  }

  async countAutoRepliesSince(sinceIso: string): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS cnt FROM app_inbox.life_inbox_triage_entries
       WHERE agent_id = ${sqlText(this.agentId)}
         AND auto_replied = TRUE
         AND created_at >= ${sqlText(sinceIso)}`,
    );
    return toNumber(rows[0]?.cnt, 0);
  }

  async cleanupOlderThan(olderThanIso: string): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM app_inbox.life_inbox_triage_entries
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
    const id = newId();
    const now = isoNow();
    const contextJson = opts.contextJson ?? {};
    const contextStr = JSON.stringify(contextJson);

    await executeRawSql(
      this.runtime,
      `INSERT INTO app_inbox.life_inbox_triage_examples (
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
      contextJson,
      createdAt: now,
    };
  }

  async getExamples(limit = 10): Promise<TriageExample[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_inbox.life_inbox_triage_examples
       WHERE agent_id = ${sqlText(this.agentId)}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return rows.map(parseTriageExample);
  }
}
