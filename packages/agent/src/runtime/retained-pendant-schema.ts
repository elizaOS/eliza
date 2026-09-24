/** Storage compatibility for existing profiles after pendant services were retired.
 * Keep the original columns, constraints and snapshot keys until an explicit
 * archive/data migration is approved. Omitting these tables makes automatic
 * schema diffing propose destructive drops; this registers no feature services.
 */

import {
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  real,
  text,
  unique,
} from "drizzle-orm/pg-core";

const pendantSessionPgSchema = pgSchema("app_lifeops");

const pendantSessions = pendantSessionPgSchema.table(
  "pendant_sessions",
  {
    id: text("id").notNull(),
    ownerId: text("owner_id").notNull(),
    agentId: text("agent_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    state: text("state").notNull(),
    processingLocation: text("processing_location").notNull(),
    revision: integer("revision").notNull().default(0),
    captureLeaseHolder: text("capture_lease_holder"),
    captureLeaseExpiresAt: text("capture_lease_expires_at"),
    captureLeaseTokenDigest: text("capture_lease_token_digest"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      name: "pendant_sessions_owner_agent_id_pk",
      columns: [t.ownerId, t.agentId, t.id],
    }),
    index("pendant_sessions_owner_agent_updated_idx").on(
      t.ownerId,
      t.agentId,
      t.updatedAt,
    ),
  ],
);

const pendantSessionSegments = pendantSessionPgSchema.table(
  "pendant_session_segments",
  {
    id: text("id").notNull(),
    sessionId: text("session_id").notNull(),
    ownerId: text("owner_id").notNull(),
    agentId: text("agent_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: text("status").notNull(),
    text: text("text").notNull(),
    wordsJson: text("words_json").notNull().default("[]"),
    speakerCluster: text("speaker_cluster"),
    speakerAlias: text("speaker_alias"),
    confidence: real("confidence"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    revision: integer("revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      name: "pendant_segments_owner_agent_session_id_pk",
      columns: [t.ownerId, t.agentId, t.sessionId, t.id],
    }),
    foreignKey({
      name: "pendant_segments_session_fk",
      columns: [t.ownerId, t.agentId, t.sessionId],
      foreignColumns: [
        pendantSessions.ownerId,
        pendantSessions.agentId,
        pendantSessions.id,
      ],
    }).onDelete("cascade"),
    unique("pendant_segments_owner_agent_session_ordinal_uniq").on(
      t.ownerId,
      t.agentId,
      t.sessionId,
      t.ordinal,
    ),
    index("pendant_segments_owner_agent_session_idx").on(
      t.ownerId,
      t.agentId,
      t.sessionId,
    ),
  ],
);

const pendantSessionInsightRefs = pendantSessionPgSchema.table(
  "pendant_session_insight_refs",
  {
    id: text("id").notNull(),
    sessionId: text("session_id").notNull(),
    ownerId: text("owner_id").notNull(),
    agentId: text("agent_id").notNull(),
    segmentIdsJson: text("segment_ids_json").notNull().default("[]"),
    revision: integer("revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      name: "pendant_insight_refs_owner_agent_session_id_pk",
      columns: [t.ownerId, t.agentId, t.sessionId, t.id],
    }),
    foreignKey({
      name: "pendant_insight_refs_session_fk",
      columns: [t.ownerId, t.agentId, t.sessionId],
      foreignColumns: [
        pendantSessions.ownerId,
        pendantSessions.agentId,
        pendantSessions.id,
      ],
    }).onDelete("cascade"),
    index("pendant_insight_refs_owner_agent_session_idx").on(
      t.ownerId,
      t.agentId,
      t.sessionId,
    ),
  ],
);

export const retainedPendantSessionSchema = {
  pendantSessions,
  pendantSessionSegments,
  pendantSessionInsightRefs,
} as const;
