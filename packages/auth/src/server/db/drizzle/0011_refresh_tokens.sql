-- Migration: refresh_tokens table
-- Stores long-lived refresh tokens (30 days) that can be exchanged for new access tokens.
-- One-time use: each refresh rotates both tokens and deletes the old refresh token.

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"         TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx"   ON "refresh_tokens" ("user_id");
