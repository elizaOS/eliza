-- PR #79 security invariants that drizzle-kit's schema diff cannot express:
-- composite cross-tenant ownership FKs, and CHECK constraints on SAML SSO
-- configs and tenant invitations. All DDL is idempotent so re-running against a
-- partially-migrated DB is safe. (Ported from the audit-hardening branch's
-- 0049/0050/0053/0054 hand-written migrations.)

-- ─── Cross-tenant agent ownership: agent-scoped rows must point at an agent in
--     the SAME tenant. Backed by the unique index on agents(tenant_id, id). ───
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_signers_tenant_agent_fk') THEN
    ALTER TABLE "agent_signers"
      ADD CONSTRAINT "agent_signers_tenant_agent_fk"
      FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agents"("tenant_id", "id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_key_quorums_tenant_agent_fk') THEN
    ALTER TABLE "agent_key_quorums"
      ADD CONSTRAINT "agent_key_quorums_tenant_agent_fk"
      FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agents"("tenant_id", "id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intents_tenant_agent_fk') THEN
    ALTER TABLE "intents"
      ADD CONSTRAINT "intents_tenant_agent_fk"
      FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agents"("tenant_id", "id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint

-- ─── SAML SSO config bounds ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_saml_sso_configs_viewer_jit_role_check') THEN
    ALTER TABLE "tenant_saml_sso_configs"
      ADD CONSTRAINT "tenant_saml_sso_configs_viewer_jit_role_check"
      CHECK ("jit_default_role" = 'viewer');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_saml_sso_configs_cert_count_check') THEN
    ALTER TABLE "tenant_saml_sso_configs"
      ADD CONSTRAINT "tenant_saml_sso_configs_cert_count_check"
      CHECK (cardinality("idp_cert_pems") BETWEEN 1 AND 5);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_saml_sso_configs_group_role_mappings_array_check') THEN
    ALTER TABLE "tenant_saml_sso_configs"
      ADD CONSTRAINT "tenant_saml_sso_configs_group_role_mappings_array_check"
      CHECK (jsonb_typeof("group_role_mappings") = 'array');
  END IF;
END $$;
--> statement-breakpoint

-- ─── Tenant invitation lifecycle ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_role_check') THEN
    ALTER TABLE "tenant_invitations"
      ADD CONSTRAINT "tenant_invitations_role_check"
      CHECK ("role" IN ('admin', 'developer', 'billing', 'viewer', 'member'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_terminal_state_check') THEN
    ALTER TABLE "tenant_invitations"
      ADD CONSTRAINT "tenant_invitations_terminal_state_check"
      CHECK (
        ("status" = 'pending' AND "accepted_at" IS NULL AND "revoked_at" IS NULL)
        OR ("status" = 'accepted' AND "accepted_at" IS NOT NULL AND "accepted_by_user_id" IS NOT NULL)
        OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
        OR ("status" = 'expired')
      );
  END IF;
END $$;
--> statement-breakpoint

-- ─── Wei-amount CHECK constraints (parity with audit branch 0051) ─────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_approval_rules_max_amount_wei_chk') THEN
    ALTER TABLE "auto_approval_rules"
      ADD CONSTRAINT "auto_approval_rules_max_amount_wei_chk" CHECK ("max_amount_wei" ~ '^[0-9]+$');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_approval_rules_escalate_above_wei_chk') THEN
    ALTER TABLE "auto_approval_rules"
      ADD CONSTRAINT "auto_approval_rules_escalate_above_wei_chk"
      CHECK ("escalate_above_wei" IS NULL OR "escalate_above_wei" ~ '^[0-9]+$');
  END IF;
END $$;
