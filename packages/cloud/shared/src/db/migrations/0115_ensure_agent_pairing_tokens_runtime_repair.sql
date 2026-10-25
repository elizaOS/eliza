-- Re-assert pairing-token schema after the Cloudflare cutover. Production can
-- have migration history ahead of the actual live schema, so keep this fully
-- idempotent and equivalent to 0108.

DO $$
BEGIN
  IF to_regclass('public.eliza_pairing_tokens') IS NOT NULL
    AND to_regclass('public.agent_pairing_tokens') IS NULL THEN
    ALTER TABLE "eliza_pairing_tokens" RENAME TO "agent_pairing_tokens";
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "agent_pairing_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "instance_url" text NOT NULL,
  "expected_origin" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agent_pairing_tokens"
  ADD COLUMN IF NOT EXISTS "token_hash" text,
  ADD COLUMN IF NOT EXISTS "organization_id" uuid,
  ADD COLUMN IF NOT EXISTS "user_id" uuid,
  ADD COLUMN IF NOT EXISTS "agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "instance_url" text,
  ADD COLUMN IF NOT EXISTS "expected_origin" text,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

DO $$
DECLARE
  fk record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'eliza_pairing_tokens_token_hash_unique'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'agent_pairing_tokens_token_hash_unique'
  ) THEN
    ALTER TABLE "agent_pairing_tokens"
      RENAME CONSTRAINT "eliza_pairing_tokens_token_hash_unique"
      TO "agent_pairing_tokens_token_hash_unique";
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'agent_pairing_tokens_token_hash_unique'
  ) THEN
    ALTER TABLE "agent_pairing_tokens"
      ADD CONSTRAINT "agent_pairing_tokens_token_hash_unique" UNIQUE ("token_hash");
  END IF;

  FOR fk IN
    SELECT * FROM (VALUES
      ('eliza_pairing_tokens_organization_id_fkey', 'agent_pairing_tokens_organization_id_fkey'),
      ('eliza_pairing_tokens_user_id_fkey', 'agent_pairing_tokens_user_id_fkey'),
      ('eliza_pairing_tokens_agent_id_fkey', 'agent_pairing_tokens_agent_id_fkey')
    ) AS names(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.agent_pairing_tokens'::regclass
        AND conname = fk.old_name
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.agent_pairing_tokens'::regclass
        AND conname = fk.new_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE "agent_pairing_tokens" RENAME CONSTRAINT %I TO %I',
        fk.old_name,
        fk.new_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'agent_pairing_tokens_organization_id_fkey'
  ) THEN
    ALTER TABLE "agent_pairing_tokens"
      ADD CONSTRAINT "agent_pairing_tokens_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'agent_pairing_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE "agent_pairing_tokens"
      ADD CONSTRAINT "agent_pairing_tokens_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_pairing_tokens'::regclass
      AND conname = 'agent_pairing_tokens_agent_id_fkey'
  ) THEN
    ALTER TABLE "agent_pairing_tokens"
      ADD CONSTRAINT "agent_pairing_tokens_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "agent_sandboxes"("id") ON DELETE cascade;
  END IF;
END $$;

DO $$
DECLARE
  rename_index record;
BEGIN
  FOR rename_index IN
    SELECT * FROM (VALUES
      ('eliza_pairing_tokens_token_hash_idx', 'agent_pairing_tokens_token_hash_idx'),
      ('eliza_pairing_tokens_expires_at_idx', 'agent_pairing_tokens_expires_at_idx'),
      ('eliza_pairing_tokens_agent_id_idx', 'agent_pairing_tokens_agent_id_idx')
    ) AS index_names(old_name, new_name)
  LOOP
    IF to_regclass(format('public.%I', rename_index.old_name)) IS NOT NULL
      AND to_regclass(format('public.%I', rename_index.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', rename_index.old_name, rename_index.new_name);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_token_hash_idx"
  ON "agent_pairing_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_expires_at_idx"
  ON "agent_pairing_tokens" ("expires_at");

CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_agent_id_idx"
  ON "agent_pairing_tokens" ("agent_id");
