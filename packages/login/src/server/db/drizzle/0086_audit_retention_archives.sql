-- Per-tenant audit retention plus durable, resumable signed archive receipts.
-- 0084 is owned by the reservation-reconciliation lane; 0085 by #201.

CREATE TABLE IF NOT EXISTS "audit_retention_policies" (
  "tenant_id" varchar(64) PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "retention_days" integer DEFAULT 365 NOT NULL,
  "archive_chunk_size" integer DEFAULT 1000 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" varchar(255),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_retention_policies_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "audit_retention_days_bounds"
    CHECK ("retention_days" BETWEEN 30 AND 3650),
  CONSTRAINT "audit_retention_chunk_bounds"
    CHECK ("archive_chunk_size" BETWEEN 1 AND 10000),
  CONSTRAINT "audit_retention_revision_positive" CHECK ("revision" > 0)
);

CREATE TABLE IF NOT EXISTS "audit_archives" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "from_seq" bigint NOT NULL,
  "to_seq" bigint NOT NULL,
  "event_count" bigint NOT NULL,
  "source" varchar(16) DEFAULT 'native' NOT NULL,
  "retention_policy_revision" integer,
  "status" varchar(16) DEFAULT 'building' NOT NULL,
  "manifest" jsonb,
  "manifest_sha256" varchar(64),
  "signature" text,
  "signing_key_id" varchar(64),
  "public_key" text,
  "durability_ack" jsonb,
  "durability_ack_key_id" varchar(64),
  "durability_ack_signature" text,
  "durability_ack_sha256" varchar(64),
  "durability_ack_at" timestamptz,
  "sealed_at" timestamptz,
  "pruned_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_archives_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "audit_archives_range_valid" CHECK ("from_seq" > 0 AND "to_seq" >= "from_seq"),
  CONSTRAINT "audit_archives_count_valid" CHECK ("event_count" = "to_seq" - "from_seq" + 1),
  CONSTRAINT "audit_archives_status_valid" CHECK ("status" IN ('building', 'sealed', 'pruned')),
  CONSTRAINT "audit_archives_source_valid" CHECK ("source" IN ('native', 'imported')),
  CONSTRAINT "audit_archives_policy_revision_valid"
    CHECK ("retention_policy_revision" IS NULL OR "retention_policy_revision" > 0),
  CONSTRAINT "audit_archives_manifest_transport_bound"
    CHECK ("manifest" IS NULL OR octet_length("manifest"::text) <= 786432),
  CONSTRAINT "audit_archives_sealed_fields_valid" CHECK (
    "status" = 'building' OR
    ("manifest" IS NOT NULL AND "manifest_sha256" ~ '^[0-9a-f]{64}$' AND
     "signature" IS NOT NULL AND "signing_key_id" IS NOT NULL AND "sealed_at" IS NOT NULL)
  ),
  CONSTRAINT "audit_archives_durability_ack_complete" CHECK (
    ("durability_ack" IS NULL AND "durability_ack_key_id" IS NULL AND
     "durability_ack_signature" IS NULL AND "durability_ack_sha256" IS NULL AND
     "durability_ack_at" IS NULL) OR
    ("durability_ack" IS NOT NULL AND "durability_ack_key_id" IS NOT NULL AND
     "durability_ack_signature" IS NOT NULL AND
     "durability_ack_sha256" ~ '^[0-9a-f]{64}$' AND "durability_ack_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "audit_archives_tenant_created_idx"
  ON "audit_archives" ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_archives_resumable_idx"
  ON "audit_archives" ("tenant_id", "status", "from_seq", "to_seq");
CREATE UNIQUE INDEX IF NOT EXISTS "audit_archives_native_authority_unique"
  ON "audit_archives"
    ("tenant_id", "from_seq", "to_seq", COALESCE("retention_policy_revision", 0))
  WHERE "source" = 'native';

CREATE TABLE IF NOT EXISTS "audit_archive_chunks" (
  "archive_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "from_seq" bigint NOT NULL,
  "to_seq" bigint NOT NULL,
  "event_count" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "byte_length" integer NOT NULL,
  "jsonl" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_archive_chunks_pk" PRIMARY KEY ("archive_id", "chunk_index"),
  CONSTRAINT "audit_archive_chunks_archive_fk"
    FOREIGN KEY ("archive_id") REFERENCES "audit_archives"("id") ON DELETE CASCADE,
  CONSTRAINT "audit_archive_chunks_range_valid"
    CHECK ("chunk_index" >= 0 AND "from_seq" > 0 AND "to_seq" >= "from_seq"),
  CONSTRAINT "audit_archive_chunks_count_valid"
    CHECK ("event_count" = "to_seq" - "from_seq" + 1 AND "event_count" BETWEEN 1 AND 10000),
  CONSTRAINT "audit_archive_chunks_bytes_valid" CHECK ("byte_length" BETWEEN 1 AND 1048576)
);

-- A durability attestation and archive provenance are write-once authority.
-- Even an application bug cannot replace an acknowledgement after it has
-- authorized destructive pruning.
CREATE OR REPLACE FUNCTION steward_guard_audit_archive_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source IS DISTINCT FROM NEW.source THEN
    RAISE EXCEPTION 'audit archive source is immutable';
  END IF;
  IF (OLD.status = 'building' AND NEW.status NOT IN ('building', 'sealed')) OR
     (OLD.status = 'sealed' AND NEW.status NOT IN ('sealed', 'pruned')) OR
     (OLD.status = 'pruned' AND NEW.status <> 'pruned') THEN
    RAISE EXCEPTION 'audit archive status transition is invalid';
  END IF;
  IF OLD.pruned_at IS NOT NULL AND OLD.pruned_at IS DISTINCT FROM NEW.pruned_at THEN
    RAISE EXCEPTION 'audit archive prune evidence is immutable';
  END IF;
  IF OLD.status IN ('sealed', 'pruned') AND (
    OLD.id IS DISTINCT FROM NEW.id OR
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR
    OLD.from_seq IS DISTINCT FROM NEW.from_seq OR
    OLD.to_seq IS DISTINCT FROM NEW.to_seq OR
    OLD.event_count IS DISTINCT FROM NEW.event_count OR
    OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision OR
    OLD.manifest IS DISTINCT FROM NEW.manifest OR
    OLD.manifest_sha256 IS DISTINCT FROM NEW.manifest_sha256 OR
    OLD.signature IS DISTINCT FROM NEW.signature OR
    OLD.signing_key_id IS DISTINCT FROM NEW.signing_key_id OR
    OLD.public_key IS DISTINCT FROM NEW.public_key OR
    OLD.sealed_at IS DISTINCT FROM NEW.sealed_at
  ) THEN
    RAISE EXCEPTION 'sealed audit archive authority is immutable';
  END IF;
  IF OLD.durability_ack IS NOT NULL AND (
    OLD.durability_ack IS DISTINCT FROM NEW.durability_ack OR
    OLD.durability_ack_key_id IS DISTINCT FROM NEW.durability_ack_key_id OR
    OLD.durability_ack_signature IS DISTINCT FROM NEW.durability_ack_signature OR
    OLD.durability_ack_sha256 IS DISTINCT FROM NEW.durability_ack_sha256 OR
    OLD.durability_ack_at IS DISTINCT FROM NEW.durability_ack_at
  ) THEN
    RAISE EXCEPTION 'audit archive durability acknowledgement is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_archives_immutability_guard ON audit_archives;
CREATE TRIGGER audit_archives_immutability_guard
BEFORE UPDATE ON audit_archives
FOR EACH ROW EXECUTE FUNCTION steward_guard_audit_archive_immutability();
