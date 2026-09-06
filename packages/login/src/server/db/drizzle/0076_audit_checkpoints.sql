-- Ed25519 audit checkpoints.
--
-- The per-tenant audit_events HMAC chain is tamper-evident but SYMMETRIC:
-- verification needs STEWARD_AUDIT_HMAC_KEY, so an third-party auditor cannot
-- confirm the chain without the operator's secret. A checkpoint signs a
-- canonical statement about the chain head with an Ed25519 PRIVATE key
-- (STEWARD_AUDIT_SIGNING_KEY) whose PUBLIC half is publishable. Bundling the
-- signed checkpoint with the exported events lets an auditor verify offline,
-- with no Steward access and no secret. See:
--   packages/api/src/services/audit-checkpoint.ts (signer)
--   packages/api/src/routes/audit.ts             (GET /audit/bundle)
--   scripts/verify-evidence-bundle.mjs           (standalone verifier)
--
-- Append-only: rows are never mutated. `payload` is the exact JSON that was
-- canonicalized+signed; `signature` is base64 Ed25519 over the canonical bytes;
-- `public_key` is the SPKI PEM (denormalized per row so bundles are
-- self-contained and key rotation is auditable).

CREATE TABLE IF NOT EXISTS "audit_checkpoints" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "seq" bigint NOT NULL,
  "head_hmac" bytea NOT NULL,
  "payload" jsonb NOT NULL,
  "signature" text NOT NULL,
  "public_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_checkpoints_tenant_seq_idx" ON "audit_checkpoints" USING btree ("tenant_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_checkpoints_tenant_created_idx" ON "audit_checkpoints" USING btree ("tenant_id","created_at");
