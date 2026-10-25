CREATE TABLE "upstream_credential_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "grant_id" uuid NOT NULL,
  "capability_id" uuid NOT NULL,
  "issuer" varchar(64) NOT NULL,
  "resource" jsonb NOT NULL,
  "resource_hash" varchar(64) NOT NULL,
  "authority_digest" varchar(64) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "token_hash" varchar(64),
  "token_ciphertext" text,
  "token_iv" text,
  "token_auth_tag" text,
  "token_salt" text,
  "status" varchar(24) DEFAULT 'issuing' NOT NULL,
  "expires_at" timestamptz,
  "delivered_at" timestamptz,
  "revoked_at" timestamptz,
  "authority_checked_at" timestamptz DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "upstream_credential_leases_status_check" CHECK ("status" IN ('issuing','delivery_pending','acknowledging','active','revoking','revoked','expired','failed','needs_attention')),
  CONSTRAINT "upstream_credential_leases_agent_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "upstream_credential_leases_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "workspaces"("tenant_id", "id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_credential_leases_replay_uniq" ON "upstream_credential_leases" ("tenant_id", "agent_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_credential_leases_tenant_id_uniq" ON "upstream_credential_leases" ("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "upstream_credential_leases_status_expiry_idx" ON "upstream_credential_leases" ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX "upstream_credential_leases_status_updated_idx" ON "upstream_credential_leases" ("status", "updated_at");
--> statement-breakpoint
CREATE INDEX "upstream_credential_leases_status_authority_checked_idx" ON "upstream_credential_leases" ("status", "authority_checked_at");
--> statement-breakpoint
CREATE INDEX "upstream_credential_leases_binding_idx" ON "upstream_credential_leases" ("tenant_id", "workspace_id", "agent_id", "grant_id");
--> statement-breakpoint
CREATE TABLE "upstream_credential_lease_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lease_id" uuid NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "action" varchar(64) NOT NULL,
  "decision" varchar(16) NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "upstream_credential_lease_events_parent_fk" FOREIGN KEY ("tenant_id", "lease_id") REFERENCES "upstream_credential_leases"("tenant_id", "id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "upstream_credential_lease_events_lease_created_idx" ON "upstream_credential_lease_events" ("lease_id", "created_at");
--> statement-breakpoint
CREATE INDEX "upstream_credential_lease_events_tenant_created_idx" ON "upstream_credential_lease_events" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_reject_upstream_lease_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'upstream credential lease evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER upstream_credential_lease_events_immutable
BEFORE UPDATE OR DELETE ON upstream_credential_lease_events
FOR EACH ROW EXECUTE FUNCTION steward_reject_upstream_lease_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER upstream_credential_leases_no_delete
BEFORE DELETE ON upstream_credential_leases
FOR EACH ROW EXECUTE FUNCTION steward_reject_upstream_lease_evidence_mutation();
