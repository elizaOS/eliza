ALTER TABLE "anonymous_sessions"
ADD COLUMN IF NOT EXISTS "gate_revision" bigint DEFAULT 0 NOT NULL;
