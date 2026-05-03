-- Discord Guilds table
-- Stores Discord servers where the bot has been added via OAuth2
CREATE TABLE IF NOT EXISTS "discord_guilds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "guild_id" text NOT NULL,
  "guild_name" text NOT NULL,
  "icon_hash" text,
  "owner_id" text,
  "bot_permissions" text,
  "bot_joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "discord_guilds_organization_id_idx" ON "discord_guilds" ("organization_id");
CREATE INDEX IF NOT EXISTS "discord_guilds_guild_id_idx" ON "discord_guilds" ("guild_id");
CREATE INDEX IF NOT EXISTS "discord_guilds_org_guild_idx" ON "discord_guilds" ("organization_id", "guild_id");
