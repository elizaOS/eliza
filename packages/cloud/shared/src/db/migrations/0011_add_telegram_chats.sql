-- Telegram Chats table
-- Stores channels and groups where the organization's bot is a member
CREATE TABLE IF NOT EXISTS "telegram_chats" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "chat_id" bigint NOT NULL,
  "chat_type" text NOT NULL,
  "title" text NOT NULL,
  "username" text,
  "is_admin" boolean NOT NULL DEFAULT false,
  "can_post_messages" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "telegram_chats_organization_id_idx" ON "telegram_chats" ("organization_id");
CREATE INDEX IF NOT EXISTS "telegram_chats_chat_id_idx" ON "telegram_chats" ("chat_id");
