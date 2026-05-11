import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { conversationMessages, conversations } from "./conversations";
import { organizations } from "./organizations";
import { users } from "./users";

export const VOICE_IMPRINT_SOURCE_KINDS = [
  "local_mic",
  "discord",
  "telegram",
  "signal",
  "whatsapp",
  "phone",
  "browser",
  "file",
  "unknown",
] as const;

export type VoiceImprintSourceKind = (typeof VOICE_IMPRINT_SOURCE_KINDS)[number];

export interface VoiceImprintSourceMetadata {
  kind: VoiceImprintSourceKind;
  sourceId?: string;
  roomId?: string;
  conversationId?: string;
  messageId?: string;
  deviceId?: string;
  connectorAccountId?: string;
  channelId?: string;
  guildId?: string;
  callId?: string;
  participantId?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceImprintClusterMetadata {
  source?: VoiceImprintSourceMetadata;
  diarizationModel?: string;
  embeddingModel?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface VoiceImprintObservationMetadata {
  source?: VoiceImprintSourceMetadata;
  diarizationModel?: string;
  embeddingModel?: string;
  segmentId?: string;
  turnId?: string;
  [key: string]: unknown;
}

export interface ConversationSpeakerAttributionMetadata {
  source?: VoiceImprintSourceMetadata;
  segmentId?: string;
  turnId?: string;
  diarizationModel?: string;
  [key: string]: unknown;
}

/**
 * Attribution-only speaker imprint clusters. These rows are evidence for
 * speaker recognition and diarization, not voice-clone assets. Identity
 * linking must go through LifeOps `EntityStore.observeIdentity` with the
 * cluster/observation ids copied into the evidence list; this table is not a
 * parallel identity graph.
 */
export const voiceImprintClusters = pgTable(
  "voice_imprint_clusters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    entityId: text("entity_id"),
    label: text("label"),
    status: text("status").notNull().default("active"),
    sourceKind: text("source_kind").$type<VoiceImprintSourceKind>().notNull(),
    sourceScopeId: text("source_scope_id"),
    centroidEmbedding: real("centroid_embedding").array(),
    embeddingModel: text("embedding_model"),
    sampleCount: integer("sample_count").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    synthesisAllowed: boolean("synthesis_allowed").notNull().default(false),
    metadata: jsonb("metadata").$type<VoiceImprintClusterMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("voice_imprint_clusters_org_idx").on(table.organizationId),
    userIdx: index("voice_imprint_clusters_user_idx").on(table.userId),
    entityIdx: index("voice_imprint_clusters_entity_idx").on(table.entityId),
    sourceIdx: index("voice_imprint_clusters_source_idx").on(
      table.organizationId,
      table.sourceKind,
      table.sourceScopeId,
    ),
    statusIdx: index("voice_imprint_clusters_status_idx").on(table.status),
    synthesisDisabledCheck: check(
      "voice_imprint_clusters_synthesis_disabled_check",
      sql`${table.synthesisAllowed} = false`,
    ),
  }),
);

/**
 * Individual voice imprint observations. Store enough attribution metadata to
 * audit a diarization decision, but keep synthesis disabled and separate from
 * `user_voices`.
 */
export const voiceImprintObservations = pgTable(
  "voice_imprint_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id").references(() => voiceImprintClusters.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    conversationMessageId: uuid("conversation_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" },
    ),
    sourceKind: text("source_kind").$type<VoiceImprintSourceKind>().notNull(),
    sourceId: text("source_id"),
    speakerLabel: text("speaker_label"),
    segmentStartMs: integer("segment_start_ms"),
    segmentEndMs: integer("segment_end_ms"),
    transcript: text("transcript"),
    embedding: real("embedding").array(),
    embeddingModel: text("embedding_model"),
    confidence: real("confidence").notNull().default(0),
    synthesisAllowed: boolean("synthesis_allowed").notNull().default(false),
    metadata: jsonb("metadata").$type<VoiceImprintObservationMetadata>().notNull().default({}),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clusterIdx: index("voice_imprint_observations_cluster_idx").on(table.clusterId),
    organizationIdx: index("voice_imprint_observations_org_idx").on(table.organizationId),
    conversationIdx: index("voice_imprint_observations_conversation_idx").on(
      table.conversationId,
    ),
    messageIdx: index("voice_imprint_observations_message_idx").on(
      table.conversationMessageId,
    ),
    sourceIdx: index("voice_imprint_observations_source_idx").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
    ),
    observedAtIdx: index("voice_imprint_observations_observed_at_idx").on(table.observedAt),
    synthesisDisabledCheck: check(
      "voice_imprint_observations_synthesis_disabled_check",
      sql`${table.synthesisAllowed} = false`,
    ),
  }),
);

/**
 * Conversation-level links between transcript spans/messages and attributed
 * speakers. This table records attribution decisions only; confirmed person
 * identity still belongs to the LifeOps entity merge path.
 */
export const conversationSpeakerAttributions = pgTable(
  "conversation_speaker_attributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    conversationMessageId: uuid("conversation_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" },
    ),
    clusterId: uuid("cluster_id").references(() => voiceImprintClusters.id, {
      onDelete: "set null",
    }),
    observationId: uuid("observation_id").references(() => voiceImprintObservations.id, {
      onDelete: "set null",
    }),
    entityId: text("entity_id"),
    sourceKind: text("source_kind").$type<VoiceImprintSourceKind>().notNull(),
    speakerLabel: text("speaker_label"),
    speakerDisplayName: text("speaker_display_name"),
    segmentStartMs: integer("segment_start_ms"),
    segmentEndMs: integer("segment_end_ms"),
    transcript: text("transcript"),
    confidence: real("confidence").notNull().default(0),
    synthesisAllowed: boolean("synthesis_allowed").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<ConversationSpeakerAttributionMetadata>()
      .notNull()
      .default({}),
    attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdx: index("conversation_speaker_attr_conversation_idx").on(
      table.conversationId,
    ),
    messageIdx: index("conversation_speaker_attr_message_idx").on(
      table.conversationMessageId,
    ),
    clusterIdx: index("conversation_speaker_attr_cluster_idx").on(table.clusterId),
    observationIdx: index("conversation_speaker_attr_observation_idx").on(
      table.observationId,
    ),
    entityIdx: index("conversation_speaker_attr_entity_idx").on(table.entityId),
    sourceIdx: index("conversation_speaker_attr_source_idx").on(
      table.organizationId,
      table.sourceKind,
    ),
    attributedAtIdx: index("conversation_speaker_attr_attributed_at_idx").on(
      table.attributedAt,
    ),
    synthesisDisabledCheck: check(
      "conversation_speaker_attr_synthesis_disabled_check",
      sql`${table.synthesisAllowed} = false`,
    ),
  }),
);

export type VoiceImprintCluster = InferSelectModel<typeof voiceImprintClusters>;
export type NewVoiceImprintCluster = InferInsertModel<typeof voiceImprintClusters>;
export type VoiceImprintObservation = InferSelectModel<typeof voiceImprintObservations>;
export type NewVoiceImprintObservation = InferInsertModel<typeof voiceImprintObservations>;
export type ConversationSpeakerAttribution = InferSelectModel<
  typeof conversationSpeakerAttributions
>;
export type NewConversationSpeakerAttribution = InferInsertModel<
  typeof conversationSpeakerAttributions
>;
