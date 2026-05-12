CREATE TABLE IF NOT EXISTS "voice_imprint_clusters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "entity_id" text,
  "label" text,
  "status" text DEFAULT 'active' NOT NULL,
  "source_kind" text NOT NULL,
  "source_scope_id" text,
  "centroid_embedding" real[],
  "embedding_model" text,
  "sample_count" integer DEFAULT 0 NOT NULL,
  "confidence" real DEFAULT 0 NOT NULL,
  "synthesis_allowed" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "voice_imprint_clusters_synthesis_disabled_check"
    CHECK ("synthesis_allowed" = false)
);

CREATE TABLE IF NOT EXISTS "voice_imprint_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cluster_id" uuid REFERENCES "voice_imprint_clusters"("id") ON DELETE set null,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE set null,
  "conversation_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE set null,
  "source_kind" text NOT NULL,
  "source_id" text,
  "speaker_label" text,
  "segment_start_ms" integer,
  "segment_end_ms" integer,
  "transcript" text,
  "embedding" real[],
  "embedding_model" text,
  "confidence" real DEFAULT 0 NOT NULL,
  "synthesis_allowed" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "voice_imprint_observations_synthesis_disabled_check"
    CHECK ("synthesis_allowed" = false)
);

CREATE TABLE IF NOT EXISTS "conversation_speaker_attributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "conversation_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE set null,
  "cluster_id" uuid REFERENCES "voice_imprint_clusters"("id") ON DELETE set null,
  "observation_id" uuid REFERENCES "voice_imprint_observations"("id") ON DELETE set null,
  "entity_id" text,
  "source_kind" text NOT NULL,
  "speaker_label" text,
  "speaker_display_name" text,
  "segment_start_ms" integer,
  "segment_end_ms" integer,
  "transcript" text,
  "confidence" real DEFAULT 0 NOT NULL,
  "synthesis_allowed" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attributed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_speaker_attr_synthesis_disabled_check"
    CHECK ("synthesis_allowed" = false)
);

CREATE INDEX IF NOT EXISTS "voice_imprint_clusters_org_idx"
  ON "voice_imprint_clusters" ("organization_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_clusters_user_idx"
  ON "voice_imprint_clusters" ("user_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_clusters_entity_idx"
  ON "voice_imprint_clusters" ("entity_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_clusters_source_idx"
  ON "voice_imprint_clusters" ("organization_id", "source_kind", "source_scope_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_clusters_status_idx"
  ON "voice_imprint_clusters" ("status");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_cluster_idx"
  ON "voice_imprint_observations" ("cluster_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_org_idx"
  ON "voice_imprint_observations" ("organization_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_conversation_idx"
  ON "voice_imprint_observations" ("conversation_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_message_idx"
  ON "voice_imprint_observations" ("conversation_message_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_source_idx"
  ON "voice_imprint_observations" ("organization_id", "source_kind", "source_id");

CREATE INDEX IF NOT EXISTS "voice_imprint_observations_observed_at_idx"
  ON "voice_imprint_observations" ("observed_at");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_conversation_idx"
  ON "conversation_speaker_attributions" ("conversation_id");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_message_idx"
  ON "conversation_speaker_attributions" ("conversation_message_id");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_cluster_idx"
  ON "conversation_speaker_attributions" ("cluster_id");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_observation_idx"
  ON "conversation_speaker_attributions" ("observation_id");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_entity_idx"
  ON "conversation_speaker_attributions" ("entity_id");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_source_idx"
  ON "conversation_speaker_attributions" ("organization_id", "source_kind");

CREATE INDEX IF NOT EXISTS "conversation_speaker_attr_attributed_at_idx"
  ON "conversation_speaker_attributions" ("attributed_at");
