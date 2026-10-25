ALTER TYPE "public"."policy_type" ADD VALUE 'aggregation' BEFORE 'contract-allowlist';--> statement-breakpoint
ALTER TYPE "public"."policy_type" ADD VALUE 'typed-data' BEFORE 'reputation-threshold';--> statement-breakpoint
ALTER TYPE "public"."policy_type" ADD VALUE 'raw-signing-chain' BEFORE 'reputation-threshold';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_chain_heads" (
	"tenant_id" varchar(64) PRIMARY KEY NOT NULL,
	"expected_seq" bigint NOT NULL,
	"expected_count" bigint NOT NULL,
	"head_hmac" "bytea" NOT NULL,
	"floor_seq" bigint DEFAULT 0 NOT NULL,
	"floor_hmac" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"jti" varchar(64) NOT NULL,
	"label" varchar(128) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_app_client_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_prefix" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_app_clients" (
	"id" varchar(64) NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"environment" varchar(32) DEFAULT 'production' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"allowed_origins" text[] DEFAULT '{}' NOT NULL,
	"allowed_redirect_urls" text[] DEFAULT '{}' NOT NULL,
	"login_methods" jsonb,
	"global_wallet_enabled" boolean DEFAULT false NOT NULL,
	"global_wallet_allowed_scopes" text[] DEFAULT '{"eth_accounts","personal_sign"}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_request_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"secret_salt" text NOT NULL,
	"secret_prefix" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "global_wallet_action_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_id" uuid NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"method" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'approved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" varchar(64),
	"provider" varchar(16) NOT NULL,
	"token" text NOT NULL,
	"platform" varchar(16),
	"device_id" varchar(255),
	"app_id" varchar(255),
	"locale" varchar(64),
	"timezone" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_wallet_app_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_agent_id" varchar(128),
	"wallet_address" varchar(128),
	"origin" text NOT NULL,
	"redirect_uri" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_configs" ALTER COLUMN "join_mode" SET DEFAULT 'invite';--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "user_id" SET DATA TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "tenant_id" SET DATA TYPE varchar(64) USING "tenant_id"::varchar(64);--> statement-breakpoint
ALTER TABLE "agent_key_quorums" ADD COLUMN IF NOT EXISTS "member_quorum_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_signers" ADD COLUMN IF NOT EXISTS "key_type" varchar(16) DEFAULT 'hmac' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_signers" ADD COLUMN IF NOT EXISTS "public_key" text;--> statement-breakpoint
ALTER TABLE "secret_routes" ADD COLUMN IF NOT EXISTS "agent_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD COLUMN IF NOT EXISTS "auth_abuse_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD COLUMN IF NOT EXISTS "test_account" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD COLUMN IF NOT EXISTS "allowed_redirect_urls" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_saml_sso_configs" ADD COLUMN IF NOT EXISTS "group_role_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "replayed_from_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_signers_tenant_id_tenants_id_fk') THEN ALTER TABLE "session_signers" ADD CONSTRAINT "session_signers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_signers_agent_id_agents_id_fk') THEN ALTER TABLE "session_signers" ADD CONSTRAINT "session_signers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_signers_tenant_agent_fk') THEN ALTER TABLE "session_signers" ADD CONSTRAINT "session_signers_tenant_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_app_clients_tenant_id_id_idx" ON "tenant_app_clients" USING btree ("tenant_id","id");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_app_client_secrets_tenant_id_tenants_id_fk') THEN ALTER TABLE "tenant_app_client_secrets" ADD CONSTRAINT "tenant_app_client_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_app_client_secrets_client_fk') THEN ALTER TABLE "tenant_app_client_secrets" ADD CONSTRAINT "tenant_app_client_secrets_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."tenant_app_clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_app_clients_tenant_id_tenants_id_fk') THEN ALTER TABLE "tenant_app_clients" ADD CONSTRAINT "tenant_app_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_request_signing_keys_tenant_id_tenants_id_fk') THEN ALTER TABLE "tenant_request_signing_keys" ADD CONSTRAINT "tenant_request_signing_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'global_wallet_action_confirmations_consent_id_user_wallet_app_consents_id_fk') THEN ALTER TABLE "global_wallet_action_confirmations" ADD CONSTRAINT "global_wallet_action_confirmations_consent_id_user_wallet_app_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."user_wallet_app_consents"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'global_wallet_action_confirmations_user_id_users_id_fk') THEN ALTER TABLE "global_wallet_action_confirmations" ADD CONSTRAINT "global_wallet_action_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_tenant_id_tenants_id_fk') THEN ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_invited_by_user_id_users_id_fk') THEN ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_accepted_by_user_id_users_id_fk') THEN ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_push_subscriptions_user_id_users_id_fk') THEN ALTER TABLE "user_push_subscriptions" ADD CONSTRAINT "user_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_push_subscriptions_tenant_id_tenants_id_fk') THEN ALTER TABLE "user_push_subscriptions" ADD CONSTRAINT "user_push_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_wallet_app_consents_user_id_users_id_fk') THEN ALTER TABLE "user_wallet_app_consents" ADD CONSTRAINT "user_wallet_app_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_wallet_app_consents_app_client_fk') THEN ALTER TABLE "user_wallet_app_consents" ADD CONSTRAINT "user_wallet_app_consents_app_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."tenant_app_clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_signers_jti_idx" ON "session_signers" USING btree ("jti");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_signers_tenant_agent_idx" ON "session_signers" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_signers_active_idx" ON "session_signers" USING btree ("agent_id") WHERE "session_signers"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_app_client_secrets_tenant_client_idx" ON "tenant_app_client_secrets" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_app_client_secrets_status_idx" ON "tenant_app_client_secrets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_app_clients_tenant_id_idx" ON "tenant_app_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_request_signing_keys_tenant_idx" ON "tenant_request_signing_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_request_signing_keys_tenant_status_idx" ON "tenant_request_signing_keys" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "global_wallet_action_confirmations_consent_idx" ON "global_wallet_action_confirmations" USING btree ("consent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "global_wallet_action_confirmations_user_status_idx" ON "global_wallet_action_confirmations" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_invitations_token_hash_idx" ON "tenant_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invitations_tenant_status_idx" ON "tenant_invitations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_invitations_pending_email_idx" ON "tenant_invitations" USING btree ("tenant_id",lower("email")) WHERE "tenant_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_push_subscriptions_user_status_idx" ON "user_push_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_push_subscriptions_tenant_user_idx" ON "user_push_subscriptions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_push_subscriptions_active_token_idx" ON "user_push_subscriptions" USING btree ("user_id","provider","token") WHERE "user_push_subscriptions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_wallet_app_consents_tenant_client_user_idx" ON "user_wallet_app_consents" USING btree ("tenant_id","client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_wallet_app_consents_active_unique_idx" ON "user_wallet_app_consents" USING btree ("tenant_id","client_id","user_id","origin") WHERE "user_wallet_app_consents"."status" = 'active';--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_users_id_fk') THEN ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_tenant_id_tenants_id_fk') THEN ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_id_id_idx" ON "agents" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_routes_agent_idx" ON "secret_routes" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_api_key_hash_unique_idx" ON "tenants" USING btree ("api_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_owner_address_unique" ON "tenants" USING btree ("owner_address") WHERE "tenants"."owner_address" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_replayed_from_idx" ON "webhook_deliveries" USING btree ("replayed_from_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_unique_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_guest_expires_at_idx" ON "users" USING btree ("guest_expires_at") WHERE "users"."is_guest" = true;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_approval_rules_max_amount_wei_chk') THEN ALTER TABLE "auto_approval_rules" ADD CONSTRAINT "auto_approval_rules_max_amount_wei_chk" CHECK ("auto_approval_rules"."max_amount_wei" ~ '^[0-9]+$'); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_approval_rules_escalate_above_wei_chk') THEN ALTER TABLE "auto_approval_rules" ADD CONSTRAINT "auto_approval_rules_escalate_above_wei_chk" CHECK ("auto_approval_rules"."escalate_above_wei" IS NULL OR "auto_approval_rules"."escalate_above_wei" ~ '^[0-9]+$'); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_value_wei_chk') THEN ALTER TABLE "transactions" ADD CONSTRAINT "transactions_value_wei_chk" CHECK ("transactions"."value" ~ '^[0-9]+$'); END IF; END $$;