-- Discord Channels table
-- Stores channels within Discord guilds where the bot can operate
CREATE TABLE IF NOT EXISTS "discord_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "channel_name" text NOT NULL,
  "channel_type" integer NOT NULL,
  "parent_id" text,
  "position" integer,
  "can_send_messages" boolean NOT NULL DEFAULT true,
  "can_embed_links" boolean NOT NULL DEFAULT true,
  "can_attach_files" boolean NOT NULL DEFAULT true,
  "is_nsfw" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "discord_channels_organization_id_idx" ON "discord_channels" ("organization_id");
CREATE INDEX IF NOT EXISTS "discord_channels_guild_id_idx" ON "discord_channels" ("guild_id");
CREATE INDEX IF NOT EXISTS "discord_channels_channel_id_idx" ON "discord_channels" ("channel_id");
CREATE INDEX IF NOT EXISTS "discord_channels_guild_channel_idx" ON "discord_channels" ("guild_id", "channel_id");
