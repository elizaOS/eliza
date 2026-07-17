/**
 * Repository for pendant session snapshots over normalized runtime tables.
 *
 * The API boundary needs a whole-session snapshot for sync/export, but writes
 * land in session, segment, and insight-ref rows. This keeps lease ownership,
 * contiguous segment order, and revisions visible to the database while the
 * route layer enforces the domain state machine.
 */

import {
  type PendantInsightRef,
  PendantInsightRefSchema,
  PendantProcessingLocationSchema,
  type PendantSegment,
  PendantSegmentSchema,
  type PendantSession,
  PendantSessionStateSchema,
} from "@elizaos/shared/contracts/pendant-session-sync";

type RuntimeDb = {
  execute: (query: RawSqlQuery) => Promise<unknown>;
};

type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

type RuntimeWithDatabase = {
  adapter: {
    db?: unknown;
  };
};

let cachedSqlRaw: ((query: string) => RawSqlQuery) | null = null;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result
      .map((row) => asObject(row))
      .filter((row): row is Record<string, unknown> => row !== null);
  }
  const object = asObject(result);
  if (!object || !Array.isArray(object.rows)) return [];
  return object.rows
    .map((row) => asObject(row))
    .filter((row): row is Record<string, unknown> => row !== null);
}

async function getSqlRaw(): Promise<(query: string) => RawSqlQuery> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => RawSqlQuery };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

async function executeRawSql(
  runtime: RuntimeWithDatabase,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const db = runtime.adapter.db as RuntimeDb | undefined;
  if (!db || typeof db.execute !== "function") {
    throw new Error("runtime database adapter unavailable");
  }
  const raw = await getSqlRaw();
  const result = await db.execute(raw(sqlText));
  return extractRows(result);
}

function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (value === null || value === undefined || value === "") return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) return parsed as T[];
  throw new Error("[PendantSessionRepository] Expected JSON array");
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return sqlQuote(value);
}

function sqlInteger(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error("invalid numeric SQL literal");
  return String(Math.trunc(value));
}

function sqlNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error("invalid numeric SQL literal");
  return String(value);
}

function sqlJson(value: unknown): string {
  return sqlQuote(JSON.stringify(value ?? null));
}

export interface StoredCaptureLease {
  holder: string;
  expiresAt: string;
  tokenDigest: string;
}

export interface StoredPendantSessionDocument {
  schemaVersion: 1;
  session: Omit<PendantSession, "captureLease"> & {
    captureLease: StoredCaptureLease | null;
  };
  segments: PendantSegment[];
  insightRefs: PendantInsightRef[];
}

export interface PendantSessionRepository {
  load(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<StoredPendantSessionDocument | null>;
  create(stored: StoredPendantSessionDocument): Promise<boolean>;
  saveSession(stored: StoredPendantSessionDocument): Promise<void>;
  saveSegment(
    stored: StoredPendantSessionDocument,
    segment: PendantSegment,
  ): Promise<void>;
  replaceInsightRefs(stored: StoredPendantSessionDocument): Promise<void>;
  delete(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void>;
}

function rowSession(
  row: Record<string, unknown>,
): StoredPendantSessionDocument["session"] {
  const holder = row.capture_lease_holder
    ? toText(row.capture_lease_holder)
    : null;
  const expiresAt = row.capture_lease_expires_at
    ? toText(row.capture_lease_expires_at)
    : null;
  const tokenDigest = row.capture_lease_token_digest
    ? toText(row.capture_lease_token_digest)
    : null;
  const captureLease =
    holder && expiresAt && tokenDigest
      ? { holder, expiresAt, tokenDigest }
      : null;

  return {
    id: toText(row.id),
    ownerId: toText(row.owner_id),
    agentId: toText(row.agent_id),
    startedAt: toText(row.started_at),
    endedAt: row.ended_at ? toText(row.ended_at) : null,
    state: PendantSessionStateSchema.parse(toText(row.state)),
    captureLease,
    processingLocation: PendantProcessingLocationSchema.parse(
      toText(row.processing_location),
    ),
    revision: toNumber(row.revision, 0),
  };
}

function rowSegment(row: Record<string, unknown>): PendantSegment {
  return PendantSegmentSchema.parse({
    id: toText(row.id),
    sessionId: toText(row.session_id),
    ordinal: toNumber(row.ordinal, 0),
    status: toText(row.status),
    text: toText(row.text),
    words: parseJsonArray(row.words_json),
    speakerCluster: row.speaker_cluster ? toText(row.speaker_cluster) : null,
    speakerAlias: row.speaker_alias ? toText(row.speaker_alias) : null,
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : toNumber(row.confidence, 0),
    error: row.error ? toText(row.error) : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    startedAt: toText(row.started_at),
    endedAt: row.ended_at ? toText(row.ended_at) : null,
    revision: toNumber(row.revision, 0),
  });
}

function rowInsightRef(row: Record<string, unknown>): PendantInsightRef {
  return PendantInsightRefSchema.parse({
    id: toText(row.id),
    segmentIds: parseJsonArray(row.segment_ids_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    revision: toNumber(row.revision, 0),
  });
}

export class SqlPendantSessionRepository implements PendantSessionRepository {
  constructor(private readonly runtime: RuntimeWithDatabase) {}

  async load(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<StoredPendantSessionDocument | null> {
    const [sessionRow] = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.pendant_sessions
        WHERE owner_id = ${sqlQuote(params.ownerId)}
          AND agent_id = ${sqlQuote(params.agentId)}
          AND id = ${sqlQuote(params.sessionId)}
        LIMIT 1`,
    );
    if (!sessionRow) return null;

    const [segmentRows, insightRows] = await Promise.all([
      executeRawSql(
        this.runtime,
        `SELECT *
           FROM app_lifeops.pendant_session_segments
          WHERE owner_id = ${sqlQuote(params.ownerId)}
            AND agent_id = ${sqlQuote(params.agentId)}
            AND session_id = ${sqlQuote(params.sessionId)}
          ORDER BY ordinal ASC`,
      ),
      executeRawSql(
        this.runtime,
        `SELECT *
           FROM app_lifeops.pendant_session_insight_refs
          WHERE owner_id = ${sqlQuote(params.ownerId)}
            AND agent_id = ${sqlQuote(params.agentId)}
            AND session_id = ${sqlQuote(params.sessionId)}
          ORDER BY created_at ASC, id ASC`,
      ),
    ]);

    return {
      schemaVersion: 1,
      session: rowSession(sessionRow),
      segments: segmentRows.map(rowSegment),
      insightRefs: insightRows.map(rowInsightRef),
    };
  }

  async create(stored: StoredPendantSessionDocument): Promise<boolean> {
    const session = stored.session;
    const lease = session.captureLease;
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.pendant_sessions (
         id, owner_id, agent_id, started_at, ended_at, state,
         processing_location, revision, capture_lease_holder,
         capture_lease_expires_at, capture_lease_token_digest,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(session.id)},
         ${sqlQuote(session.ownerId)},
         ${sqlQuote(session.agentId)},
         ${sqlQuote(session.startedAt)},
         ${sqlText(session.endedAt)},
         ${sqlQuote(session.state)},
         ${sqlQuote(session.processingLocation)},
         ${sqlInteger(session.revision)},
         ${sqlText(lease?.holder)},
         ${sqlText(lease?.expiresAt)},
         ${sqlText(lease?.tokenDigest)},
         ${sqlQuote(session.startedAt)},
         ${sqlQuote(session.startedAt)}
       )
       ON CONFLICT (owner_id, agent_id, id) DO NOTHING
       RETURNING id`,
    );
    return rows.length === 1;
  }

  async saveSession(stored: StoredPendantSessionDocument): Promise<void> {
    const now = new Date().toISOString();
    const session = stored.session;
    const lease = session.captureLease;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.pendant_sessions (
         id, owner_id, agent_id, started_at, ended_at, state,
         processing_location, revision, capture_lease_holder,
         capture_lease_expires_at, capture_lease_token_digest,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(session.id)},
         ${sqlQuote(session.ownerId)},
         ${sqlQuote(session.agentId)},
         ${sqlQuote(session.startedAt)},
         ${sqlText(session.endedAt)},
         ${sqlQuote(session.state)},
         ${sqlQuote(session.processingLocation)},
         ${sqlInteger(session.revision)},
         ${sqlText(lease?.holder)},
         ${sqlText(lease?.expiresAt)},
         ${sqlText(lease?.tokenDigest)},
         ${sqlQuote(session.startedAt)},
         ${sqlQuote(now)}
       )
       ON CONFLICT (owner_id, agent_id, id) DO UPDATE SET
         ended_at = EXCLUDED.ended_at,
         state = EXCLUDED.state,
         processing_location = EXCLUDED.processing_location,
         revision = EXCLUDED.revision,
         capture_lease_holder = EXCLUDED.capture_lease_holder,
         capture_lease_expires_at = EXCLUDED.capture_lease_expires_at,
         capture_lease_token_digest = EXCLUDED.capture_lease_token_digest,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async saveSegment(
    stored: StoredPendantSessionDocument,
    segment: PendantSegment,
  ): Promise<void> {
    const session = stored.session;
    await this.saveSession(stored);
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.pendant_session_segments (
         id, session_id, owner_id, agent_id, ordinal, status, text, words_json,
         speaker_cluster, speaker_alias, confidence, error, started_at,
         ended_at, revision, created_at, updated_at
       ) VALUES (
         ${sqlQuote(segment.id)},
         ${sqlQuote(session.id)},
         ${sqlQuote(session.ownerId)},
         ${sqlQuote(session.agentId)},
         ${sqlInteger(segment.ordinal)},
         ${sqlQuote(segment.status)},
         ${sqlQuote(segment.text)},
         ${sqlJson(segment.words)},
         ${sqlText(segment.speakerCluster)},
         ${sqlText(segment.speakerAlias)},
         ${sqlNumber(segment.confidence)},
         ${sqlText(segment.error)},
         ${sqlQuote(segment.startedAt)},
         ${sqlText(segment.endedAt)},
         ${sqlInteger(segment.revision)},
         ${sqlQuote(segment.createdAt)},
         ${sqlQuote(segment.updatedAt)}
       )
       ON CONFLICT (owner_id, agent_id, session_id, id) DO UPDATE SET
         ordinal = EXCLUDED.ordinal,
         status = EXCLUDED.status,
         text = EXCLUDED.text,
         words_json = EXCLUDED.words_json,
         speaker_cluster = EXCLUDED.speaker_cluster,
         speaker_alias = EXCLUDED.speaker_alias,
         confidence = EXCLUDED.confidence,
         error = EXCLUDED.error,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         revision = EXCLUDED.revision,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async replaceInsightRefs(
    stored: StoredPendantSessionDocument,
  ): Promise<void> {
    const session = stored.session;
    await this.saveSession(stored);
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.pendant_session_insight_refs
        WHERE owner_id = ${sqlQuote(session.ownerId)}
          AND agent_id = ${sqlQuote(session.agentId)}
          AND session_id = ${sqlQuote(session.id)}`,
    );
    for (const ref of stored.insightRefs) {
      await executeRawSql(
        this.runtime,
        `INSERT INTO app_lifeops.pendant_session_insight_refs (
           id, session_id, owner_id, agent_id, segment_ids_json,
           revision, created_at, updated_at
         ) VALUES (
           ${sqlQuote(ref.id)},
           ${sqlQuote(session.id)},
           ${sqlQuote(session.ownerId)},
           ${sqlQuote(session.agentId)},
           ${sqlJson(ref.segmentIds)},
           ${sqlInteger(ref.revision)},
           ${sqlQuote(ref.createdAt)},
           ${sqlQuote(ref.updatedAt)}
         )`,
      );
    }
  }

  async delete(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.pendant_session_insight_refs
        WHERE owner_id = ${sqlQuote(params.ownerId)}
          AND agent_id = ${sqlQuote(params.agentId)}
          AND session_id = ${sqlQuote(params.sessionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.pendant_session_segments
        WHERE owner_id = ${sqlQuote(params.ownerId)}
          AND agent_id = ${sqlQuote(params.agentId)}
          AND session_id = ${sqlQuote(params.sessionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.pendant_sessions
        WHERE owner_id = ${sqlQuote(params.ownerId)}
          AND agent_id = ${sqlQuote(params.agentId)}
          AND id = ${sqlQuote(params.sessionId)}`,
    );
  }
}

function cloneStored(
  stored: StoredPendantSessionDocument,
): StoredPendantSessionDocument {
  return {
    schemaVersion: 1,
    session: {
      ...stored.session,
      captureLease: stored.session.captureLease
        ? { ...stored.session.captureLease }
        : null,
    },
    segments: stored.segments.map((segment) => ({
      ...segment,
      words: [...segment.words],
    })),
    insightRefs: stored.insightRefs.map((ref) => ({
      ...ref,
      segmentIds: [...ref.segmentIds],
    })),
  };
}

export class InMemoryPendantSessionRepository
  implements PendantSessionRepository
{
  private readonly rows = new Map<string, StoredPendantSessionDocument>();

  private key(ownerId: string, agentId: string, sessionId: string): string {
    return `${ownerId}:${agentId}:${sessionId}`;
  }

  async load(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<StoredPendantSessionDocument | null> {
    const stored = this.rows.get(
      this.key(params.ownerId, params.agentId, params.sessionId),
    );
    return stored ? cloneStored(stored) : null;
  }

  async create(stored: StoredPendantSessionDocument): Promise<boolean> {
    const key = this.key(
      stored.session.ownerId,
      stored.session.agentId,
      stored.session.id,
    );
    if (this.rows.has(key)) return false;
    this.rows.set(key, cloneStored(stored));
    return true;
  }

  async saveSession(stored: StoredPendantSessionDocument): Promise<void> {
    const key = this.key(
      stored.session.ownerId,
      stored.session.agentId,
      stored.session.id,
    );
    const existing = this.rows.get(key) ?? {
      schemaVersion: 1 as const,
      session: stored.session,
      segments: [],
      insightRefs: [],
    };
    this.rows.set(
      key,
      cloneStored({
        ...existing,
        session: stored.session,
      }),
    );
  }

  async saveSegment(
    stored: StoredPendantSessionDocument,
    segment: PendantSegment,
  ): Promise<void> {
    const key = this.key(
      stored.session.ownerId,
      stored.session.agentId,
      stored.session.id,
    );
    const next = cloneStored(stored);
    const index = next.segments.findIndex((item) => item.id === segment.id);
    if (index >= 0) {
      next.segments[index] = { ...segment, words: [...segment.words] };
    } else {
      next.segments.push({ ...segment, words: [...segment.words] });
    }
    next.segments.sort((a, b) => a.ordinal - b.ordinal);
    this.rows.set(key, next);
  }

  async replaceInsightRefs(
    stored: StoredPendantSessionDocument,
  ): Promise<void> {
    const key = this.key(
      stored.session.ownerId,
      stored.session.agentId,
      stored.session.id,
    );
    this.rows.set(key, cloneStored(stored));
  }

  async delete(params: {
    ownerId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void> {
    this.rows.delete(
      this.key(params.ownerId, params.agentId, params.sessionId),
    );
  }
}

export function createPendantSessionRepository(
  runtime: RuntimeWithDatabase,
): PendantSessionRepository {
  return new SqlPendantSessionRepository(runtime);
}
