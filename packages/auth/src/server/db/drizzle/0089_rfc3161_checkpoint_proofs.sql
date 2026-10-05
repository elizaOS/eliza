-- Persist the exact independently verified RFC 3161 proof beside the signed
-- checkpoint it timestamps. Rows are append-only evidence.

ALTER TABLE "audit_checkpoints"
  ADD COLUMN IF NOT EXISTS "anchor_proof" jsonb,
  ADD COLUMN IF NOT EXISTS "anchor_verified_at" timestamptz;

ALTER TABLE "audit_checkpoints"
  DROP CONSTRAINT IF EXISTS "audit_checkpoints_anchor_complete";
ALTER TABLE "audit_checkpoints"
  ADD CONSTRAINT "audit_checkpoints_anchor_complete" CHECK (
    ("anchor_proof" IS NULL AND "anchor_verified_at" IS NULL) OR
    ("anchor_proof" IS NOT NULL AND "anchor_verified_at" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION steward_guard_audit_checkpoint_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit checkpoints are append-only evidence';
END;
$$;

DROP TRIGGER IF EXISTS audit_checkpoints_immutability_guard ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_immutability_guard
BEFORE UPDATE OR DELETE ON audit_checkpoints
FOR EACH ROW EXECUTE FUNCTION steward_guard_audit_checkpoint_immutability();
