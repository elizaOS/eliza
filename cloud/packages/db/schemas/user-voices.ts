import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * User voices table schema.
 *
 * Stores ElevenLabs voice clones with usage tracking and cost information.
 */
export const userVoices = pgTable(
  "user_voices",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Ownership
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // ElevenLabs Integration
    elevenlabsVoiceId: text("elevenlabs_voice_id").notNull().unique(),

    // Voice Metadata
    name: text("name").notNull(),
    description: text("description"),
    cloneType: text("clone_type", {
      enum: ["instant", "professional"],
    }).notNull(),

    // Settings (stability, similarity_boost, style, use_speaker_boost, language, etc.)
    settings: jsonb("settings").notNull().default({}),

    // Metadata
    sampleCount: integer("sample_count").notNull().default(0),
    totalAudioDurationSeconds: integer("total_audio_duration_seconds"),
    audioQualityScore: decimal("audio_quality_score", {
      precision: 3,
      scale: 2,
    }), // 0.00 - 10.00

    // Usage Tracking
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at"),

    // Status
    isActive: boolean("is_active").notNull().default(true),
    isPublic: boolean("is_public").notNull().default(false), // Allow sharing in gallery

    // Cost Tracking
    creationCost: numeric("creation_cost", {
      precision: 10,
      scale: 2,
    }).notNull(), // Cost in USD to create

    // Audit
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Index for organization queries (listing user voices)
    organization_idx: index("user_voices_organization_idx").on(table.organizationId),
    // Index for user queries
    user_idx: index("user_voices_user_idx").on(table.userId),
    // Index for finding voices by organization and clone type (slot counting)
    org_type_idx: index("user_voices_org_type_idx").on(table.organizationId, table.cloneType),
    // Index for organization + usage analytics (most used voices)
    org_usage_idx: index("user_voices_org_usage_idx").on(
      table.organizationId,
      table.usageCount,
      table.lastUsedAt,
    ),
  }),
);

/**
 * Voice cloning jobs table schema.
 *
 * Tracks voice cloning job status and progress for instant and professional clones.
 */
export const voiceCloningJobs = pgTable("voice_cloning_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Ownership
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // Job Details
  jobType: text("job_type", { enum: ["instant", "professional"] }).notNull(),
  voiceName: text("voice_name").notNull(),
  voiceDescription: text("voice_description"),

  // Status
  status: text("status", {
    enum: ["pending", "processing", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  progress: integer("progress").notNull().default(0),

  // Results
  userVoiceId: uuid("user_voice_id").references(() => userVoices.id, {
    onDelete: "set null",
  }),
  elevenlabsVoiceId: text("elevenlabs_voice_id"),

  // Error Handling
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),

  // Metadata
  metadata: jsonb("metadata").notNull().default({}),

  // Timestamps
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Voice samples table schema.
 *
 * Stores audio samples used for voice cloning with quality metrics.
 */
export const voiceSamples = pgTable("voice_samples", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Ownership
  userVoiceId: uuid("user_voice_id").references(() => userVoices.id, {
    onDelete: "cascade",
  }),
  jobId: uuid("job_id").references(() => voiceCloningJobs.id, {
    onDelete: "cascade",
  }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // File Details
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(), // bytes
  fileType: text("file_type").notNull(), // audio/mpeg, audio/wav, etc.
  blobUrl: text("blob_url").notNull(), // R2 storage URL

  // Audio Metadata
  durationSeconds: decimal("duration_seconds", { precision: 10, scale: 2 }),
  sampleRate: integer("sample_rate"),
  channels: integer("channels"),
  qualityScore: decimal("quality_score", { precision: 3, scale: 2 }), // 0.00 - 10.00

  // Processing
  isProcessed: boolean("is_processed").notNull().default(false),
  transcription: text("transcription"), // Optional: what was said in the sample

  // Audit
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Types
export type UserVoice = InferSelectModel<typeof userVoices>;
export type NewUserVoice = InferInsertModel<typeof userVoices>;
export type VoiceCloningJob = InferSelectModel<typeof voiceCloningJobs>;
export type NewVoiceCloningJob = InferInsertModel<typeof voiceCloningJobs>;
export type VoiceSample = InferSelectModel<typeof voiceSamples>;
export type NewVoiceSample = InferInsertModel<typeof voiceSamples>;
