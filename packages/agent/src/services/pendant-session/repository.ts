/**
 * Repository for pendant session snapshots over normalized runtime tables.
 *
 * The API boundary needs a whole-session snapshot for sync/export, but writes
 * land in session, segment, and insight-ref rows. This keeps lease ownership,
 * contiguous segment order, and revisions visible to the database while the
 * route layer enforces the domain state machine.
 */

import {
  executeRawSqlOnDb,
  parseRawSqlJsonArray,
  type RuntimeRawSqlDb,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  coerceRawSqlNumber as toNumber,
  coerceRawSqlText as toText,
} from "@elizaos/core";
import {
  type PendantInsightRef,
  PendantInsightRefSchema,
  PendantProcessingLocationSchema,
  type PendantSegment,
  PendantSegmentSchema,
  type PendantSession,
  PendantSessionStateSchema,
} from "@elizaos/shared/contracts/pendant-session-sync";

type RuntimeDb = RuntimeRawSqlDb & {
  transaction?: <T>(work: (tx: RuntimeDb) => Promise<T>) => Promise<T>;
};

type RuntimeWithDatabase = {
  adapter: {
    db?: unknown;
  };
};

const rawSqlOptions = { subsystem: "PendantSessionRepository" } as const;

async function executeRawSql(
  runtime: RuntimeWithDatabase,
  sqlText: string,
  executor?: RuntimeDb,
): Promise<Array<Record<string, unknown>>> {
  const db = executor ?? (runtime.adapter.db as RuntimeDb | undefined);
  if (!db || typeof db.execute !== "function") {
    throw new Error("runtime database adapter unavailable");
  }
  return executeRawSqlOnDb(db, sqlText, rawSqlOptions);
}

async function runTransaction<T>(
  runtime: RuntimeWithDatabase,
  work: (db: RuntimeDb) => Promise<T>,
): Promise<T> {
  const db = runtime.adapter.db as RuntimeDb | undefined;
  if (!db || typeof db.transaction !== "function") {
    throw new Error("runtime database transaction adapter unavailable");
  }
  return db.transaction((tx) => work(tx));
}

function parseJsonArray<T>(value: unknown): T[] {
  return parseRawSqlJsonArray<T>(value, rawSqlOptions);
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
  loadLatest(params: {
    ownerId: string;
    agentId: string;
  }): Promise<StoredPendantSessionDocument | null>;
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

export class PendantSessionRevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    message = "Pendant session revision does not match",
  ) {
    super(message);
    this.name = "PendantSessionRevisionConflictError";
  }
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

  private async currentRevision(
    session: StoredPendantSessionDocument["session"],
    executor: RuntimeDb,
  ): Promise<number | null> {
    const [row] = await executeRawSql(
      this.runtime,
      `SELECT revision
         FROM app_lifeops.pendant_sessions
        WHERE owner_id = ${sqlQuote(session.ownerId)}
          AND agent_id = ${sqlQuote(session.agentId)}
          AND id = ${sqlQuote(session.id)}
        LIMIT 1`,
      executor,
    );
    return row ? toNumber(row.revision, 0) : null;
  }

  private async saveSessionWithDb(
    stored: StoredPendantSessionDocument,
    executor: RuntimeDb,
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = stored.session;
    const lease = session.captureLease;
    const expectedRevision = session.revision - 1;
    if (expectedRevision < 0) {
      throw new Error("session revision update requires a prior revision");
    }
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.pendant_sessions
          SET ended_at = ${sqlText(session.endedAt)},
              state = ${sqlQuote(session.state)},
              processing_location = ${sqlQuote(session.processingLocation)},
              revision = ${sqlInteger(session.revision)},
              capture_lease_holder = ${sqlText(lease?.holder)},
              capture_lease_expires_at = ${sqlText(lease?.expiresAt)},
              capture_lease_token_digest = ${sqlText(lease?.tokenDigest)},
              updated_at = ${sqlQuote(now)}
        WHERE owner_id = ${sqlQuote(session.ownerId)}
          AND agent_id = ${sqlQuote(session.agentId)}
          AND id = ${sqlQuote(session.id)}
          AND revision = ${sqlInteger(expectedRevision)}
        RETURNING revision`,
      executor,
    );
    if (rows.length === 1) return;
    const currentRevision = await this.currentRevision(session, executor);
    if (currentRevision !== null) {
      throw new PendantSessionRevisionConflictError(currentRevision);
    }
    throw new Error("pendant session row disappeared during revision update");
  }

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

  async loadLatest(params: {
    ownerId: string;
    agentId: string;
  }): Promise<StoredPendantSessionDocument | null> {
    const [row] = await executeRawSql(
      this.runtime,
      `SELECT id
         FROM app_lifeops.pendant_sessions
        WHERE owner_id = ${sqlQuote(params.ownerId)}
          AND agent_id = ${sqlQuote(params.agentId)}
          AND state <> 'ended'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    );
    const sessionId = row ? toText(row.id).trim() : "";
    if (!sessionId) return null;
    return this.load({ ...params, sessionId });
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
    const db = this.runtime.adapter.db as RuntimeDb | undefined;
    if (!db || typeof db.execute !== "function") {
      throw new Error("runtime database adapter unavailable");
    }
    await this.saveSessionWithDb(stored, db);
  }

  async saveSegment(
    stored: StoredPendantSessionDocument,
    segment: PendantSegment,
  ): Promise<void> {
    const session = stored.session;
    await runTransaction(this.runtime, async (tx) => {
      await this.saveSessionWithDb(stored, tx);
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
        tx,
      );
    });
  }

  async replaceInsightRefs(
    stored: StoredPendantSessionDocument,
  ): Promise<void> {
    const session = stored.session;
    await runTransaction(this.runtime, async (tx) => {
      await this.saveSessionWithDb(stored, tx);
      await executeRawSql(
        this.runtime,
        `DELETE FROM app_lifeops.pendant_session_insight_refs
          WHERE owner_id = ${sqlQuote(session.ownerId)}
            AND agent_id = ${sqlQuote(session.agentId)}
            AND session_id = ${sqlQuote(session.id)}`,
        tx,
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
          tx,
        );
      }
    });
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

  async loadLatest(params: {
    ownerId: string;
    agentId: string;
  }): Promise<StoredPendantSessionDocument | null> {
    const latest = [...this.rows.values()]
      .filter(
        (stored) =>
          stored.session.ownerId === params.ownerId &&
          stored.session.agentId === params.agentId &&
          stored.session.state !== "ended",
      )
      .sort((left, right) => {
        const byStartedAt = right.session.startedAt.localeCompare(
          left.session.startedAt,
        );
        return byStartedAt !== 0
          ? byStartedAt
          : right.session.id.localeCompare(left.session.id);
      })[0];
    return latest ? cloneStored(latest) : null;
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
    next.segments.sort((a, b) => {
      const aOrdinal =
        typeof a.ordinal === "number" && Number.isFinite(a.ordinal)
          ? a.ordinal
          : 0;
      const bOrdinal =
        typeof b.ordinal === "number" && Number.isFinite(b.ordinal)
          ? b.ordinal
          : 0;
      return aOrdinal - bOrdinal || a.id.localeCompare(b.id);
    });
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
