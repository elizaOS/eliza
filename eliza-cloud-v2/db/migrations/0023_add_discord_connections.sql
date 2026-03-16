-- Discord Connections table for gateway service
-- Tracks Discord bot connections and their pod assignments
-- Bot tokens are encrypted at rest using envelope encryption (AES-256-GCM)

CREATE TABLE IF NOT EXISTS "discord_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "character_id" uuid REFERENCES "user_characters"("id") ON DELETE SET NULL,
  "application_id" text NOT NULL,
  "bot_user_id" text, -- Set when bot connects, used for mention detection
  
  -- Encrypted bot token (envelope encryption with KMS)
  "bot_token_encrypted" text NOT NULL,
  "encrypted_dek" text NOT NULL,
  "token_nonce" text NOT NULL,
  "token_auth_tag" text NOT NULL,
  "encryption_key_id" text NOT NULL,
  
  -- Gateway assignment
  "assigned_pod" text,
  "status" text NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'connecting', 'connected', 'disconnected', 'error')),
  "error_message" text,
  
  -- Connection stats
  "guild_count" integer DEFAULT 0,
  "events_received" integer DEFAULT 0,
  "events_routed" integer DEFAULT 0,
  
  -- Heartbeat tracking
  "last_heartbeat" timestamp with time zone,
  "connected_at" timestamp with time zone,
  
  -- Configuration (default Discord intents: GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | MESSAGE_CONTENT)
  -- Value: (1<<0) | (1<<9) | (1<<10) | (1<<12) | (1<<15) = 38401
  "intents" integer DEFAULT 38401,
  "is_active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb,
  
  -- Timestamps
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS "discord_connections_organization_id_idx" ON "discord_connections" ("organization_id");
CREATE INDEX IF NOT EXISTS "discord_connections_character_id_idx" ON "discord_connections" ("character_id");
CREATE INDEX IF NOT EXISTS "discord_connections_assigned_pod_idx" ON "discord_connections" ("assigned_pod");
CREATE INDEX IF NOT EXISTS "discord_connections_status_idx" ON "discord_connections" ("status");
CREATE INDEX IF NOT EXISTS "discord_connections_is_active_idx" ON "discord_connections" ("is_active");

-- Composite index for assignUnassignedToPod query (SELECT ... WHERE is_active AND assigned_pod IS NULL ORDER BY created_at)
CREATE INDEX IF NOT EXISTS "discord_connections_unassigned_idx" 
  ON "discord_connections" ("is_active", "assigned_pod", "created_at") 
  WHERE "is_active" = true AND "assigned_pod" IS NULL;

-- One bot per Discord application per organization (prevents duplicate connections)
CREATE UNIQUE INDEX IF NOT EXISTS "discord_connections_org_app_unique_idx" 
  ON "discord_connections" ("organization_id", "application_id");
