CREATE TABLE IF NOT EXISTS "agent_backup_gc_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "object_id" uuid NOT NULL,
  "action" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "claim_owner" text,
  "claim_generation" uuid,
  "lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT NOW(),
  "expected_locator_digest" text NOT NULL,
  "expected_key_fingerprint" text NOT NULL,
  "expected_provider_version_id" text,
  "expected_provider_etag" text,
  "expected_provider_checksum" text,
  "expected_provider_write_started" boolean NOT NULL DEFAULT FALSE,
  "receipt_digest" text,
  "last_error_code" text,
  "last_error" text,
  "last_failure_generation" uuid,
  "last_failure_digest" text,
  "context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "agent_backup_gc_outbox_object_tenant_fkey"
    FOREIGN KEY ("object_id", "organization_id")
    REFERENCES "agent_backup_objects"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_gc_outbox_claim_shape_check" CHECK ((
    "state" <> 'leased' AND "claim_owner" IS NULL
      AND "claim_generation" IS NULL AND "lease_expires_at" IS NULL
  ) OR (
    "state" = 'leased' AND "claim_owner" IS NOT NULL AND "claim_owner" <> ''
      AND "claim_generation" IS NOT NULL AND "lease_expires_at" IS NOT NULL
  )),
  CONSTRAINT "agent_backup_gc_outbox_state_check" CHECK (
    "state" IN ('pending', 'leased', 'completed', 'quarantined')
      AND "action" = 'delete_object'
  ),
  CONSTRAINT "agent_backup_gc_outbox_receipt_shape_check" CHECK (
    ("state" <> 'completed' AND "completed_at" IS NULL AND "receipt_digest" IS NULL)
    OR ("state" = 'completed' AND "completed_at" IS NOT NULL
      AND "receipt_digest" IS NOT NULL AND "receipt_digest" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "agent_backup_gc_outbox_counters_check" CHECK (
    "attempts" >= 0
      AND "expected_locator_digest" ~ '^[0-9a-f]{64}$'
      AND "expected_key_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "agent_backup_gc_outbox_failure_replay_check" CHECK (
    (("last_failure_generation" IS NULL AND "last_failure_digest" IS NULL)
    OR ("last_failure_generation" IS NOT NULL
      AND "last_failure_digest" IS NOT NULL
      AND "last_failure_digest" ~ '^[0-9a-f]{64}$')) IS TRUE
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_gc_outbox_action_uidx"
  ON "agent_backup_gc_outbox" ("object_id", "action");
CREATE INDEX IF NOT EXISTS "agent_backup_gc_outbox_due_idx"
  ON "agent_backup_gc_outbox" ("next_attempt_at", "created_at")
  WHERE "state" IN ('pending', 'leased');
