-- Durable restore-v3 isolated-candidate metadata. The cleanup outbox is the
-- parent authority and is inserted first; no plaintext payload or bearer token
-- has a PostgreSQL column.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_backup_restore_operations_v3_candidate_authority_unique'
      AND conrelid = 'agent_backup_restore_operations'::regclass
  ) THEN
    ALTER TABLE "agent_backup_restore_operations" ADD CONSTRAINT
      "agent_backup_restore_operations_v3_candidate_authority_unique" UNIQUE
      ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
       "lease_id", "lease_owner_id", "lease_generation", "catalog_epoch", "copy_role",
       "expected_operation_id", "expected_activation_generation",
       "expected_lifecycle_revision", "expected_manifest_sha256");
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidate_cleanup_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "cleanup_command_sha256" text NOT NULL,
  "state" text NOT NULL DEFAULT 'armed',
  "claim_owner" text,
  "claim_generation" uuid,
  "lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "receipt_sha256" text,
  "quarantine_reason_sha256" text,
  "completed_at" timestamptz,
  "quarantined_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_cleanup_outbox_authority_unique" UNIQUE
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id"),
  CONSTRAINT "agent_backup_restore_v3_cleanup_outbox_identity_check" CHECK ((
    "cleanup_command_sha256" ~ '^[0-9a-f]{64}$' AND "attempts" >= 0
    AND "next_attempt_at" >= "created_at"
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_cleanup_outbox_claim_shape_check" CHECK ((
    ("state" <> 'leased' AND "claim_owner" IS NULL
      AND "claim_generation" IS NULL AND "lease_expires_at" IS NULL)
    OR ("state" = 'leased' AND btrim("claim_owner") = "claim_owner"
      AND octet_length("claim_owner") BETWEEN 1 AND 255
      AND "claim_generation" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_cleanup_outbox_terminal_shape_check" CHECK ((
    ("state" IN ('armed', 'held', 'pending', 'leased')
      AND num_nonnulls("receipt_sha256", "quarantine_reason_sha256",
        "completed_at", "quarantined_at") = 0)
    OR ("state" = 'completed' AND "receipt_sha256" ~ '^[0-9a-f]{64}$'
      AND "completed_at" IS NOT NULL AND "quarantine_reason_sha256" IS NULL
      AND "quarantined_at" IS NULL)
    OR ("state" = 'quarantined'
      AND "quarantine_reason_sha256" ~ '^[0-9a-f]{64}$'
      AND "quarantined_at" IS NOT NULL AND "receipt_sha256" IS NULL
      AND "completed_at" IS NULL)
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_cleanup_outbox_attempt_uidx"
  ON "agent_backup_restore_v3_candidate_cleanup_outbox"
  ("organization_id", "restore_attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_v3_cleanup_outbox_due_idx"
  ON "agent_backup_restore_v3_candidate_cleanup_outbox" ("next_attempt_at", "created_at")
  WHERE "state" IN ('armed', 'pending', 'leased');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "restore_operation_id" uuid NOT NULL,
  "lease_id" uuid NOT NULL,
  "lease_owner_id" text NOT NULL,
  "lease_generation" uuid NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "catalog_epoch" bigint NOT NULL,
  "source_copy_role" text NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" numeric(20, 0) NOT NULL,
  "expected_manifest_sha256" text NOT NULL,
  "key_bundle_generation_id" uuid NOT NULL,
  "source_authority_canonical" text NOT NULL,
  "source_authority_sha256" text NOT NULL,
  "object_count" integer NOT NULL,
  "cleanup_outbox_id" uuid NOT NULL,
  "execution_token_sha256" text NOT NULL,
  "state" text NOT NULL DEFAULT 'active',
  "sealed_receipt_canonical" text,
  "sealed_receipt_sha256" text,
  "sealed_staged_payload_bytes" bigint,
  "sealed_staged_data_record_count" integer,
  "abort_reason_sha256" text,
  "sealed_at" timestamptz,
  "aborted_at" timestamptz,
  "retention_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_candidates_cleanup_authority_fkey" FOREIGN KEY
    ("cleanup_outbox_id", "organization_id", "agent_id", "backup_id",
     "restore_attempt_id", "operation_id")
    REFERENCES "agent_backup_restore_v3_candidate_cleanup_outbox"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_candidates_lease_authority_fkey" FOREIGN KEY
    ("lease_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "lease_owner_id", "lease_generation", "catalog_epoch", "source_copy_role", "operation_id",
     "source_activation_generation", "source_lifecycle_revision", "expected_manifest_sha256")
    REFERENCES "agent_backup_restore_leases"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "owner_id",
     "generation", "catalog_epoch", "copy_role", "operation_id", "activation_generation",
     "lifecycle_revision", "expected_manifest_sha256")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_candidates_operation_authority_fkey" FOREIGN KEY
    ("restore_operation_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "lease_id", "lease_owner_id", "lease_generation", "catalog_epoch", "source_copy_role",
     "operation_id", "source_activation_generation", "source_lifecycle_revision",
     "expected_manifest_sha256")
    REFERENCES "agent_backup_restore_operations"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "lease_id",
     "lease_owner_id", "lease_generation", "catalog_epoch", "copy_role",
     "expected_operation_id", "expected_activation_generation", "expected_lifecycle_revision",
     "expected_manifest_sha256")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_candidates_execution_authority_unique" UNIQUE
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id",
     "execution_token_sha256"),
  CONSTRAINT "agent_backup_restore_v3_candidates_seal_binding_unique" UNIQUE
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id",
     "execution_token_sha256", "expected_manifest_sha256", "key_bundle_generation_id",
     "source_copy_role", "source_authority_sha256", "object_count"),
  CONSTRAINT "agent_backup_restore_v3_candidates_authority_shape_check" CHECK ((
    "catalog_epoch" >= 0
    AND "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "source_copy_role" IN ('primary', 'secondary')
    AND btrim("lease_owner_id") = "lease_owner_id"
    AND octet_length("lease_owner_id") BETWEEN 1 AND 255
    AND "expected_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND octet_length("source_authority_canonical") BETWEEN 2 AND 16777216
    AND "source_authority_sha256" ~ '^[0-9a-f]{64}$'
    AND "execution_token_sha256" ~ '^[0-9a-f]{64}$'
    AND "object_count" BETWEEN 1 AND 8192
    AND "lease_expires_at" > "created_at"
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_candidates_terminal_shape_check" CHECK ((
    ("state" = 'active' AND num_nonnulls("sealed_receipt_canonical",
      "sealed_receipt_sha256", "sealed_staged_payload_bytes",
      "sealed_staged_data_record_count", "abort_reason_sha256", "sealed_at", "aborted_at",
      "retention_until") = 0)
    OR ("state" = 'sealed'
      AND octet_length("sealed_receipt_canonical") BETWEEN 2 AND 16777216
      AND left("sealed_receipt_canonical", 1) = '{'
      AND right("sealed_receipt_canonical", 1) = '}'
      AND jsonb_typeof("sealed_receipt_canonical"::jsonb) = 'object'
      AND "sealed_receipt_sha256" ~ '^[0-9a-f]{64}$'
      AND "sealed_staged_payload_bytes" BETWEEN 0 AND 1073741824
      AND "sealed_staged_data_record_count" BETWEEN 0 AND 16384
      AND "sealed_at" IS NOT NULL AND "abort_reason_sha256" IS NULL
      AND "retention_until" > "sealed_at" AND "aborted_at" IS NULL)
    OR ("state" = 'aborted' AND "abort_reason_sha256" ~ '^[0-9a-f]{64}$'
      AND "aborted_at" IS NOT NULL AND "sealed_receipt_canonical" IS NULL
      AND "sealed_receipt_sha256" IS NULL AND "sealed_staged_payload_bytes" IS NULL
      AND "sealed_staged_data_record_count" IS NULL AND "sealed_at" IS NULL
      AND "retention_until" > "aborted_at")
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidates_attempt_uidx"
  ON "agent_backup_restore_v3_candidates" ("organization_id", "restore_attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidates_cleanup_uidx"
  ON "agent_backup_restore_v3_candidates" ("cleanup_outbox_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidates_execution_token_sha256_uidx"
  ON "agent_backup_restore_v3_candidates" ("execution_token_sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidates_state_idx"
  ON "agent_backup_restore_v3_candidates" ("state", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidate_stage_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "candidate_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "execution_token_sha256" text NOT NULL,
  "command_kind" text NOT NULL,
  "component_index" smallint NOT NULL,
  "component_name" text NOT NULL,
  "data_index" integer,
  "offset_bytes" bigint,
  "entry_path" text,
  "entry_file_offset_bytes" bigint,
  "entry_file_size_bytes" bigint,
  "entry_mode" integer,
  "entry_mtime_ms" bigint,
  "entry_metadata_sha256" text,
  "payload_bytes" bigint NOT NULL,
  "payload_sha256" text NOT NULL,
  "data_frame_count" integer,
  "descriptor_format" text,
  "descriptor_compression" text,
  "descriptor_content_kind" text,
  "descriptor_consistency" text,
  "descriptor_sha256" text,
  "record_stream_content_hmac_sha256" text,
  "command_sha256" text NOT NULL,
  "receipt_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_stage_ledger_candidate_execution_fkey" FOREIGN KEY
    ("candidate_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "operation_id", "execution_token_sha256")
    REFERENCES "agent_backup_restore_v3_candidates"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id",
     "execution_token_sha256") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_stage_ledger_digest_check" CHECK ((
    "payload_sha256" ~ '^[0-9a-f]{64}$'
    AND "command_sha256" ~ '^[0-9a-f]{64}$'
    AND "receipt_sha256" ~ '^[0-9a-f]{64}$'
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_stage_ledger_component_check" CHECK ((
    ("component_index", "component_name") IN (
      (0, 'character'), (1, 'database'), (2, 'media'),
      (3, 'state-files'), (4, 'vault')
    )
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_stage_ledger_command_shape_check" CHECK ((
    ("command_kind" = 'record' AND "data_index" BETWEEN 0 AND 16383
      AND "offset_bytes" BETWEEN 0 AND 1073741824
      AND "entry_metadata_sha256" ~ '^[0-9a-f]{64}$'
      AND ((num_nonnulls("entry_path", "entry_file_offset_bytes", "entry_file_size_bytes",
          "entry_mode", "entry_mtime_ms") = 0)
        OR ("entry_path" IS NOT NULL AND octet_length("entry_path") BETWEEN 1 AND 1024
          AND "entry_path" !~ '(^/|(^|/)\.\.(/|$)|[[:cntrl:]])'
          AND "entry_file_offset_bytes" BETWEEN 0 AND 1073741824
          AND "entry_file_size_bytes" BETWEEN 0 AND 1073741824
          AND "entry_mode" BETWEEN 0 AND 511 AND "entry_mtime_ms" >= 0
          AND num_nonnulls("entry_path", "entry_file_offset_bytes", "entry_file_size_bytes",
            "entry_mode", "entry_mtime_ms") = 5))
      AND "payload_bytes" BETWEEN 0 AND 262144
      AND "data_frame_count" IS NULL
      AND num_nonnulls("descriptor_format", "descriptor_compression",
        "descriptor_content_kind", "descriptor_consistency") = 0
      AND "descriptor_sha256" IS NULL AND "record_stream_content_hmac_sha256" IS NULL)
    OR ("command_kind" = 'finish' AND "data_index" IS NULL AND "offset_bytes" IS NULL
      AND num_nonnulls("entry_path", "entry_file_offset_bytes", "entry_file_size_bytes",
        "entry_mode", "entry_mtime_ms") = 0 AND "entry_metadata_sha256" IS NULL
      AND "payload_bytes" BETWEEN 0 AND 1073741824
      AND "data_frame_count" BETWEEN 0 AND 16384
      AND (("component_name" = 'character'
          AND ROW("descriptor_format", "descriptor_compression", "descriptor_content_kind",
            "descriptor_consistency") =
            ROW('runtime-character-json-v1', 'none', 'opaque', 'best-effort'))
        OR ("component_name" = 'database'
          AND ROW("descriptor_format", "descriptor_compression", "descriptor_content_kind",
            "descriptor_consistency") =
            ROW('pglite-data-dir-tar-gzip-v1', 'gzip', 'opaque', 'transactional'))
        OR ("component_name" IN ('media', 'state-files', 'vault')
          AND ROW("descriptor_format", "descriptor_compression", "descriptor_content_kind",
            "descriptor_consistency") = ROW('file-set-v1', 'none', 'file-set', 'best-effort')))
      AND "descriptor_sha256" ~ '^[0-9a-f]{64}$'
      AND "record_stream_content_hmac_sha256" ~ '^[0-9a-f]{64}$')
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_stage_ledger_record_slot_uidx"
  ON "agent_backup_restore_v3_candidate_stage_ledger"
  ("candidate_id", "component_index", "data_index") WHERE "command_kind" = 'record';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_stage_ledger_finish_slot_uidx"
  ON "agent_backup_restore_v3_candidate_stage_ledger" ("candidate_id", "component_index")
  WHERE "command_kind" = 'finish';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_v3_stage_ledger_component_idx"
  ON "agent_backup_restore_v3_candidate_stage_ledger"
  ("candidate_id", "component_index", "data_index");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidate_seal_authorizations" (
  "id" uuid PRIMARY KEY,
  "candidate_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "execution_token_sha256" text NOT NULL,
  "expected_manifest_sha256" text NOT NULL,
  "key_bundle_generation_id" uuid NOT NULL,
  "source_copy_role" text NOT NULL,
  "source_authority_sha256" text NOT NULL,
  "object_count" integer NOT NULL,
  "candidate_receipt_sha256" text NOT NULL,
  "authorization_request_sha256" text NOT NULL,
  "proof_token_sha256" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "state" text NOT NULL DEFAULT 'active',
  "consumed_at" timestamptz,
  "revoked_at" timestamptz,
  "revocation_reason_sha256" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_seal_auth_candidate_binding_fkey" FOREIGN KEY
    ("candidate_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "operation_id", "execution_token_sha256", "expected_manifest_sha256",
     "key_bundle_generation_id", "source_copy_role", "source_authority_sha256", "object_count")
    REFERENCES "agent_backup_restore_v3_candidates"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id",
     "execution_token_sha256", "expected_manifest_sha256", "key_bundle_generation_id",
     "source_copy_role", "source_authority_sha256", "object_count") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_seal_auth_terminal_command_unique" UNIQUE
    ("id", "candidate_id", "proof_token_sha256", "candidate_receipt_sha256"),
  CONSTRAINT "agent_backup_restore_v3_seal_auth_authority_shape_check" CHECK ((
    "expected_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "source_copy_role" IN ('primary', 'secondary')
    AND "source_authority_sha256" ~ '^[0-9a-f]{64}$'
    AND "execution_token_sha256" ~ '^[0-9a-f]{64}$'
    AND "candidate_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND "authorization_request_sha256" ~ '^[0-9a-f]{64}$'
    AND "proof_token_sha256" ~ '^[0-9a-f]{64}$'
    AND "object_count" BETWEEN 1 AND 8192
    AND "expires_at" > "created_at"
  ) IS TRUE),
  CONSTRAINT "agent_backup_restore_v3_seal_auth_terminal_shape_check" CHECK ((
    ("state" = 'active'
      AND num_nonnulls("consumed_at", "revoked_at", "revocation_reason_sha256") = 0)
    OR ("state" = 'consumed' AND "consumed_at" IS NOT NULL
      AND "revoked_at" IS NULL AND "revocation_reason_sha256" IS NULL)
    OR ("state" = 'revoked' AND "consumed_at" IS NULL AND "revoked_at" IS NOT NULL
      AND "revocation_reason_sha256" ~ '^[0-9a-f]{64}$')
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_seal_auth_active_candidate_uidx"
  ON "agent_backup_restore_v3_candidate_seal_authorizations" ("candidate_id")
  WHERE "state" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_seal_auth_proof_token_sha256_uidx"
  ON "agent_backup_restore_v3_candidate_seal_authorizations" ("proof_token_sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_v3_seal_authorizations_expiry_idx"
  ON "agent_backup_restore_v3_candidate_seal_authorizations" ("expires_at", "created_at")
  WHERE "state" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidate_terminal_commands" (
  "id" uuid PRIMARY KEY,
  "candidate_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "execution_token_sha256" text NOT NULL,
  "command_kind" text NOT NULL,
  "authorization_id" uuid,
  "proof_token_sha256" text,
  "sealed_receipt_canonical" text,
  "sealed_receipt_sha256" text,
  "abort_reason_sha256" text,
  "command_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_terminal_candidate_execution_fkey" FOREIGN KEY
    ("candidate_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "operation_id", "execution_token_sha256")
    REFERENCES "agent_backup_restore_v3_candidates"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "operation_id",
     "execution_token_sha256") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_terminal_commands_authorization_fkey" FOREIGN KEY
    ("authorization_id", "candidate_id", "proof_token_sha256", "sealed_receipt_sha256")
    REFERENCES "agent_backup_restore_v3_candidate_seal_authorizations"
    ("id", "candidate_id", "proof_token_sha256", "candidate_receipt_sha256")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_v3_terminal_commands_shape_check" CHECK ((
    "execution_token_sha256" ~ '^[0-9a-f]{64}$'
    AND "command_sha256" ~ '^[0-9a-f]{64}$'
    AND (("command_kind" = 'seal' AND "authorization_id" IS NOT NULL
        AND "proof_token_sha256" ~ '^[0-9a-f]{64}$'
        AND octet_length("sealed_receipt_canonical") BETWEEN 2 AND 16777216
        AND "sealed_receipt_sha256" ~ '^[0-9a-f]{64}$'
        AND "abort_reason_sha256" IS NULL)
      OR ("command_kind" = 'abort' AND "authorization_id" IS NULL
        AND "proof_token_sha256" IS NULL AND "sealed_receipt_canonical" IS NULL
        AND "sealed_receipt_sha256" IS NULL
        AND "abort_reason_sha256" ~ '^[0-9a-f]{64}$'))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_terminal_commands_candidate_uidx"
  ON "agent_backup_restore_v3_candidate_terminal_commands" ("candidate_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_v3_candidate_gc_tombstones" (
  "id" uuid PRIMARY KEY,
  "candidate_id" uuid NOT NULL,
  "cleanup_outbox_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "terminal_state" text NOT NULL,
  "terminal_evidence_sha256" text NOT NULL,
  "retention_until" timestamptz NOT NULL,
  "gc_command_sha256" text NOT NULL,
  "state" text NOT NULL DEFAULT 'armed',
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_restore_v3_candidate_gc_tombstones_shape_check" CHECK ((
    "terminal_state" IN ('sealed', 'aborted')
    AND "terminal_evidence_sha256" ~ '^[0-9a-f]{64}$'
    AND "gc_command_sha256" ~ '^[0-9a-f]{64}$'
    AND (("state" = 'armed' AND "completed_at" IS NULL)
      OR ("state" = 'completed' AND "completed_at" IS NOT NULL))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidate_gc_candidate_uidx"
  ON "agent_backup_restore_v3_candidate_gc_tombstones" ("candidate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_v3_candidate_gc_tenant_idx"
  ON "agent_backup_restore_v3_candidate_gc_tombstones" ("organization_id", "created_at");
